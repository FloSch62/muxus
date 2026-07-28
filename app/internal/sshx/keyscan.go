package sshx

// Discover the user's SSH identities for the host editor's key picker: the
// private keys sitting in ~/.ssh (type/comment from the .pub sibling,
// encrypted-or-not from a parse probe) and what the agent currently holds,
// cross-referenced by fingerprint so the UI can badge keys as loaded.
//
// Direct port of server/src/ssh/key-scan.ts.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"

	"github.com/FloSch62/muxus/app/internal/api"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

var scanPrivateKeyHeaders = []string{
	"-----BEGIN OPENSSH PRIVATE KEY-----",
	"-----BEGIN RSA PRIVATE KEY-----",
	"-----BEGIN EC PRIVATE KEY-----",
	"-----BEGIN DSA PRIVATE KEY-----",
	"-----BEGIN ENCRYPTED PRIVATE KEY-----",
	"-----BEGIN PRIVATE KEY-----",
	"PuTTY-User-Key-File-",
}

// scanSkipFileRe matches files in ~/.ssh that are definitely not private keys.
var scanSkipFileRe = regexp.MustCompile(`(?i)^(config|known_hosts|authorized_keys)|\.(pub|old|bak|tmp)$|muxus`)

// scanPassphraseRe recognizes "this key is encrypted" parse failures.
var scanPassphraseRe = regexp.MustCompile(`(?i)passphrase|encrypted`)

const scanMaxKeyFileBytes = 1024 * 1024

// AgentSocket returns the agent endpoint: $SSH_AUTH_SOCK, or the OpenSSH
// named pipe on Windows.
func AgentSocket() string {
	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		return sock
	}
	if runtime.GOOS == "windows" {
		return `\\.\pipe\openssh-ssh-agent`
	}
	return ""
}

// ListAgentKeys lists the identities currently loaded in the SSH agent.
// Any failure to reach or query the agent yields an empty list.
func ListAgentKeys() []api.SshAgentKey {
	out := []api.SshAgentKey{}
	sock := AgentSocket()
	if sock == "" {
		return out
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return out
	}
	defer conn.Close()
	keys, err := agent.NewClient(conn).List()
	if err != nil {
		return out
	}
	for _, k := range keys {
		out = append(out, api.SshAgentKey{
			Type:        k.Type(),
			Comment:     k.Comment,
			Fingerprint: ssh.FingerprintSHA256(k),
		})
	}
	return out
}

// ListSshKeys scans dir (default ~/.ssh) for private keys and reports them
// together with the agent state. Errors reading the directory or individual
// files simply drop the affected entries, like the TypeScript scanner.
func ListSshKeys(dir string) api.SshKeysResponse {
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".ssh")
	}
	agentKeys := ListAgentKeys()
	agentPrints := make(map[string]bool, len(agentKeys))
	for _, k := range agentKeys {
		agentPrints[k.Fingerprint] = true
	}
	keys := []api.SshKeyInfo{}

	var names []string
	if entries, err := os.ReadDir(dir); err == nil {
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		if scanSkipFileRe.MatchString(name) {
			continue
		}
		filePath := filepath.Join(dir, name)
		stat, err := os.Stat(filePath)
		if err != nil || !stat.Mode().IsRegular() || stat.Size() > scanMaxKeyFileBytes {
			continue
		}
		content, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}
		head := string(content[:min(64, len(content))])
		if !scanHasPrivateKeyHeader(head) {
			continue
		}

		signer, probeErr := ssh.ParsePrivateKey(content)
		encrypted := probeErr != nil
		if probeErr != nil && !scanPassphraseRe.MatchString(probeErr.Error()) {
			continue // not actually a usable key
		}

		var keyType, comment, fingerprint string
		if signer != nil {
			pub := signer.PublicKey()
			keyType = pub.Type()
			fingerprint = ssh.FingerprintSHA256(pub)
			comment = scanOpenSshComment(content)
		}

		// The .pub sibling names the algorithm and comment even for encrypted keys.
		if pubText, err := os.ReadFile(filePath + ".pub"); err == nil {
			pub := strings.Fields(strings.TrimSpace(string(pubText)))
			if len(pub) >= 2 && pub[0] != "" && pub[1] != "" {
				if keyType == "" {
					keyType = pub[0]
				}
				if comment == "" {
					comment = strings.Join(pub[2:], " ")
				}
				if fingerprint == "" {
					if blob, err := base64.StdEncoding.DecodeString(pub[1]); err == nil {
						fingerprint = scanFingerprintBlob(blob)
					}
				}
			}
		}

		keys = append(keys, api.SshKeyInfo{
			Path:      filePath,
			Name:      name,
			Type:      keyType,
			Comment:   comment,
			Encrypted: encrypted,
			InAgent:   fingerprint != "" && agentPrints[fingerprint],
		})
	}

	agentAvailable := AgentSocket() != "" && (runtime.GOOS != "windows" || len(agentKeys) > 0)
	return api.SshKeysResponse{AgentAvailable: agentAvailable, AgentKeys: agentKeys, Keys: keys}
}

func scanHasPrivateKeyHeader(head string) bool {
	for _, h := range scanPrivateKeyHeaders {
		if strings.HasPrefix(head, h) {
			return true
		}
	}
	return false
}

// scanFingerprintBlob hashes a raw public key blob into the same SHA256:…
// presentation ssh.FingerprintSHA256 produces, mirroring
// fingerprintSha256(Buffer) for unparsed .pub content.
func scanFingerprintBlob(blob []byte) string {
	sum := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// scanOpenSshComment extracts the key comment embedded in an unencrypted
// openssh-key-v1 private key; x/crypto's parser does not expose it.
func scanOpenSshComment(pemBytes []byte) string {
	block, _ := pem.Decode(pemBytes)
	if block == nil || block.Type != "OPENSSH PRIVATE KEY" {
		return ""
	}
	data := block.Bytes
	magic := []byte("openssh-key-v1\x00")
	if !bytes.HasPrefix(data, magic) {
		return ""
	}
	offset := len(magic)
	next := func() ([]byte, bool) {
		value, end, ok := certReadField(data, offset)
		if ok {
			offset = end
		}
		return value, ok
	}
	cipher, ok := next()
	if !ok || string(cipher) != "none" {
		return ""
	}
	if _, ok := next(); !ok { // kdfname
		return ""
	}
	if _, ok := next(); !ok { // kdfoptions
		return ""
	}
	if offset+4 > len(data) {
		return ""
	}
	numKeys := binary.BigEndian.Uint32(data[offset:])
	offset += 4
	if numKeys != 1 {
		return ""
	}
	if _, ok := next(); !ok { // public key blob
		return ""
	}
	priv, ok := next()
	if !ok || len(priv) < 8 {
		return ""
	}
	// checkint, checkint, key type, type-specific fields, comment, padding.
	keyType, pos, ok := certReadField(priv, 8)
	if !ok {
		return ""
	}
	count := scanPrivFieldCount(string(keyType))
	if count < 0 {
		return ""
	}
	for i := 0; i < count; i++ {
		_, end, ok := certReadField(priv, pos)
		if !ok {
			return ""
		}
		pos = end
	}
	comment, _, ok := certReadField(priv, pos)
	if !ok {
		return ""
	}
	return string(comment)
}

func scanPrivFieldCount(keyType string) int {
	switch {
	case keyType == "ssh-ed25519":
		return 2
	case keyType == "ssh-rsa":
		return 6
	case keyType == "ssh-dss":
		return 5
	case strings.HasPrefix(keyType, "ecdsa-sha2-"):
		return 3
	}
	return -1
}
