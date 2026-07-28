package sshx

// Host key verification against the real OpenSSH files: ~/.ssh/known_hosts
// (read + write) and /etc/ssh/ssh_known_hosts (read only). Supports plain,
// wildcard and hashed (|1|salt|hmac) host entries, `[host]:port` notation and
// the @revoked marker. First contact asks the user (TOFU) and appends a plain
// entry, like `ssh` with HashKnownHosts=no; accepting a changed key replaces
// the stale same-type entries the way `ssh-keygen -R` would, keeping a
// known_hosts.old backup.
//
// Matching is delegated to github.com/skeema/knownhosts (which wraps
// golang.org/x/crypto/ssh/knownhosts); the record/replace writer is a direct
// port of server/src/ssh/known-hosts.ts.

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/skeema/knownhosts"
	"golang.org/x/crypto/ssh"
	xknownhosts "golang.org/x/crypto/ssh/knownhosts"
)

// KnownHostState is the discriminant of a KnownHostVerdict.
type KnownHostState string

const (
	KnownHostOk      KnownHostState = "ok"
	KnownHostUnknown KnownHostState = "unknown"
	KnownHostChanged KnownHostState = "changed"
	KnownHostRevoked KnownHostState = "revoked"
)

// KnownHostVerdict mirrors the KnownHostVerdict union: Previous carries the
// SHA256:… fingerprint of the stale key and is set only for KnownHostChanged.
type KnownHostVerdict struct {
	State    KnownHostState
	Previous string
}

// DefaultKnownHostsPath is ~/.ssh/known_hosts.
func DefaultKnownHostsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ssh", "known_hosts")
}

const khGlobalKnownHosts = "/etc/ssh/ssh_known_hosts"

// KnownHostsStore verifies and records host keys in OpenSSH's files.
type KnownHostsStore struct {
	userFile   string
	globalFile string
}

// NewKnownHostsStore builds a store over the given user (read + write) and
// global (read only) files. Empty strings select the OpenSSH defaults.
func NewKnownHostsStore(userFile, globalFile string) *KnownHostsStore {
	if userFile == "" {
		userFile = DefaultKnownHostsPath()
	}
	if globalFile == "" {
		globalFile = khGlobalKnownHosts
	}
	return &KnownHostsStore{userFile: userFile, globalFile: globalFile}
}

// Verify checks the presented host key against the user file, then the global
// file. A same-type entry with a different key yields KnownHostChanged with
// the previous key's fingerprint; a different key type is first contact.
func (s *KnownHostsStore) Verify(host string, port int, key ssh.PublicKey) KnownHostVerdict {
	files := make([]string, 0, 2)
	for _, f := range []string{s.userFile, s.globalFile} {
		if _, err := os.Stat(f); err == nil {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		return KnownHostVerdict{State: KnownHostUnknown}
	}
	db, err := knownhosts.NewDB(files...)
	if err != nil {
		return KnownHostVerdict{State: KnownHostUnknown}
	}

	hostPort := net.JoinHostPort(strings.ToLower(host), strconv.Itoa(port))
	remote := &net.TCPAddr{IP: net.IPv4zero, Port: port}
	err = db.HostKeyCallback()(hostPort, remote, key)
	if err == nil {
		return KnownHostVerdict{State: KnownHostOk}
	}
	var revokedErr *xknownhosts.RevokedError
	if errors.As(err, &revokedErr) {
		return KnownHostVerdict{State: KnownHostRevoked}
	}
	var keyErr *xknownhosts.KeyError
	if errors.As(err, &keyErr) {
		for _, want := range keyErr.Want {
			if want.Key.Type() == key.Type() {
				return KnownHostVerdict{State: KnownHostChanged, Previous: ssh.FingerprintSHA256(want.Key)}
			}
		}
	}
	return KnownHostVerdict{State: KnownHostUnknown}
}

// Record stores an accepted key: drop stale same-type entries for the host
// (the `ssh-keygen -R` part, backing up to known_hosts.old), then append.
func (s *KnownHostsStore) Record(host string, port int, key ssh.PublicKey) error {
	names := khHostNames(host, port)
	keyType := key.Type()
	if err := os.MkdirAll(filepath.Dir(s.userFile), 0o700); err != nil {
		return err
	}

	var lines []string
	if text, err := os.ReadFile(s.userFile); err == nil {
		if err := os.WriteFile(s.userFile+".old", text, 0o600); err != nil {
			return err
		}
		lines = khSplitLines(string(text))
		for len(lines) > 0 && lines[len(lines)-1] == "" {
			lines = lines[:len(lines)-1]
		}
	}

	kept := make([]string, 0, len(lines)+1)
	for _, line := range lines {
		entry := khParseLine(line)
		if entry == nil || entry.marker != "" || entry.keyType != keyType || !khEntryMatches(entry.hosts, names) {
			kept = append(kept, line)
		}
	}
	kept = append(kept, names[0]+" "+keyType+" "+base64.StdEncoding.EncodeToString(key.Marshal()))

	tmp := s.userFile + ".muxus.tmp"
	if err := os.WriteFile(tmp, []byte(strings.Join(kept, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.userFile)
}

// khHostNames lists the names OpenSSH would store/check for this host+port.
func khHostNames(host string, port int) []string {
	h := strings.ToLower(host)
	if port == 22 {
		return []string{h, "[" + h + "]:22"}
	}
	return []string{fmt.Sprintf("[%s]:%d", h, port)}
}

// khSplitLines splits on \r?\n like the TypeScript writer.
func khSplitLines(text string) []string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSuffix(line, "\r")
	}
	return lines
}

type khLine struct {
	marker  string // "", "revoked" or "cert-authority"
	hosts   string
	keyType string
	keyB64  string
}

func khParseLine(raw string) *khLine {
	line := strings.TrimSpace(raw)
	if line == "" || strings.HasPrefix(line, "#") {
		return nil
	}
	fields := strings.Fields(line)
	var marker string
	if fields[0] == "@revoked" || fields[0] == "@cert-authority" {
		marker = fields[0][1:]
		fields = fields[1:]
	}
	if len(fields) < 3 {
		return nil
	}
	return &khLine{marker: marker, hosts: fields[0], keyType: fields[1], keyB64: fields[2]}
}

// khEntryMatches matches one entry's host field (comma-separated patterns or
// a |1| hash) against the candidate names.
func khEntryMatches(hostsField string, names []string) bool {
	if strings.HasPrefix(hostsField, "|") {
		return khHashedMatches(hostsField, names)
	}
	matched := false
	for _, pattern := range strings.Split(hostsField, ",") {
		p := strings.ToLower(pattern)
		if p == "" {
			continue
		}
		if strings.HasPrefix(p, "!") {
			for _, n := range names {
				if khGlobMatch(p[1:], n) {
					return false
				}
			}
		} else {
			for _, n := range names {
				if khGlobMatch(p, n) {
					matched = true
					break
				}
			}
		}
	}
	return matched
}

// khHashedMatches checks |1|base64(salt)|base64(hmac-sha1(salt, host)).
func khHashedMatches(field string, names []string) bool {
	parts := strings.Split(field, "|")
	if len(parts) != 4 || parts[1] != "1" {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	hash, err := base64.StdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	for _, name := range names {
		mac := hmac.New(sha1.New, salt)
		mac.Write([]byte(name))
		if hmac.Equal(mac.Sum(nil), hash) {
			return true
		}
	}
	return false
}

var (
	khGlobMu    sync.Mutex
	khGlobCache = map[string]*regexp.Regexp{}
)

func khGlobMatch(pattern, text string) bool {
	khGlobMu.Lock()
	rx := khGlobCache[pattern]
	if rx == nil {
		var b strings.Builder
		b.WriteString("^")
		for _, r := range pattern {
			switch r {
			case '*':
				b.WriteString(".*")
			case '?':
				b.WriteString(".")
			case '.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
				b.WriteByte('\\')
				b.WriteRune(r)
			default:
				b.WriteRune(r)
			}
		}
		b.WriteString("$")
		rx = regexp.MustCompile(b.String())
		khGlobCache[pattern] = rx
	}
	khGlobMu.Unlock()
	return rx.MatchString(text)
}
