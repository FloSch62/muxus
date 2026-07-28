package sshx

// Port of tests/unit/server/known-hosts.test.ts. The vitest fixtures build
// random-but-valid key blobs; here real ed25519/RSA keys are generated so the
// x/crypto matching layer can parse them.

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func khTestKeyEd25519(t *testing.T) ssh.PublicKey {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func khTestKeyRSA(t *testing.T) ssh.PublicKey {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func khKeyB64(key ssh.PublicKey) string {
	return base64.StdEncoding.EncodeToString(key.Marshal())
}

// khHashedEntry builds a |1|salt|hmac hashed known_hosts line for host.
func khHashedEntry(host string, key ssh.PublicKey) string {
	salt := make([]byte, 20)
	if _, err := rand.Read(salt); err != nil {
		panic(err)
	}
	mac := hmac.New(sha1.New, salt)
	mac.Write([]byte(host))
	return fmt.Sprintf("|1|%s|%s %s %s",
		base64.StdEncoding.EncodeToString(salt),
		base64.StdEncoding.EncodeToString(mac.Sum(nil)),
		key.Type(), khKeyB64(key))
}

func khFreshPaths(t *testing.T) (userFile, missing string) {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "known_hosts"), filepath.Join(dir, "no-global-file")
}

func khExpectVerdict(t *testing.T, got, want KnownHostVerdict) {
	t.Helper()
	if got != want {
		t.Fatalf("verdict = %+v, want %+v", got, want)
	}
}

// "reports unknown hosts, then ok after record (TOFU)"
func TestKnownHostsTofu(t *testing.T) {
	userFile, missing := khFreshPaths(t)
	store := NewKnownHostsStore(userFile, missing)
	key := khTestKeyEd25519(t)
	khExpectVerdict(t, store.Verify("example.com", 22, key), KnownHostVerdict{State: KnownHostUnknown})
	if err := store.Record("example.com", 22, key); err != nil {
		t.Fatal(err)
	}
	khExpectVerdict(t, store.Verify("example.com", 22, key), KnownHostVerdict{State: KnownHostOk})
}

// "stores non-22 ports in [host]:port notation"
func TestKnownHostsNonStandardPort(t *testing.T) {
	userFile, missing := khFreshPaths(t)
	store := NewKnownHostsStore(userFile, missing)
	key := khTestKeyEd25519(t)
	if err := store.Record("example.com", 2222, key); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(userFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(text), "[example.com]:2222 ssh-ed25519") {
		t.Fatalf("known_hosts missing [host]:port entry: %q", text)
	}
	khExpectVerdict(t, store.Verify("example.com", 2222, key), KnownHostVerdict{State: KnownHostOk})
	khExpectVerdict(t, store.Verify("example.com", 22, key), KnownHostVerdict{State: KnownHostUnknown})
}

// "matches hashed and wildcard entries"
func TestKnownHostsHashedAndWildcardEntries(t *testing.T) {
	userFile, missing := khFreshPaths(t)
	key := khTestKeyEd25519(t)
	key2 := khTestKeyRSA(t)
	content := khHashedEntry("secret.example.com", key) + "\n" +
		"*.wild.example.com " + key2.Type() + " " + khKeyB64(key2) + "\n"
	if err := os.WriteFile(userFile, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewKnownHostsStore(userFile, missing)
	khExpectVerdict(t, store.Verify("secret.example.com", 22, key), KnownHostVerdict{State: KnownHostOk})
	khExpectVerdict(t, store.Verify("a.wild.example.com", 22, key2), KnownHostVerdict{State: KnownHostOk})
}

// "flags a same-type key change with the previous fingerprint"
func TestKnownHostsChangedKey(t *testing.T) {
	userFile, missing := khFreshPaths(t)
	store := NewKnownHostsStore(userFile, missing)
	oldKey := khTestKeyEd25519(t)
	if err := store.Record("example.com", 22, oldKey); err != nil {
		t.Fatal(err)
	}
	newKey := khTestKeyEd25519(t)
	khExpectVerdict(t, store.Verify("example.com", 22, newKey),
		KnownHostVerdict{State: KnownHostChanged, Previous: ssh.FingerprintSHA256(oldKey)})
	// A different key *type* is first contact, not a change.
	khExpectVerdict(t, store.Verify("example.com", 22, khTestKeyRSA(t)), KnownHostVerdict{State: KnownHostUnknown})
}

// "replaces stale entries on record like ssh-keygen -R, keeping a .old backup"
func TestKnownHostsReplaceKeepsBackup(t *testing.T) {
	userFile, missing := khFreshPaths(t)
	store := NewKnownHostsStore(userFile, missing)
	oldKey := khTestKeyEd25519(t)
	newKey := khTestKeyEd25519(t)
	if err := store.Record("example.com", 22, oldKey); err != nil {
		t.Fatal(err)
	}
	if err := store.Record("example.com", 22, newKey); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(userFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(text), khKeyB64(oldKey)) {
		t.Fatalf("stale key still present: %q", text)
	}
	if !strings.Contains(string(text), khKeyB64(newKey)) {
		t.Fatalf("new key missing: %q", text)
	}
	backup, err := os.ReadFile(userFile + ".old")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(backup), khKeyB64(oldKey)) {
		t.Fatalf("backup missing old key: %q", backup)
	}
	khExpectVerdict(t, store.Verify("example.com", 22, newKey), KnownHostVerdict{State: KnownHostOk})
}

// "honors @revoked markers"
func TestKnownHostsRevoked(t *testing.T) {
	userFile, missing := khFreshPaths(t)
	key := khTestKeyEd25519(t)
	line := "@revoked example.com " + key.Type() + " " + khKeyB64(key) + "\n"
	if err := os.WriteFile(userFile, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewKnownHostsStore(userFile, missing)
	khExpectVerdict(t, store.Verify("example.com", 22, key), KnownHostVerdict{State: KnownHostRevoked})
}

// "consults the global file read-only"
func TestKnownHostsGlobalFile(t *testing.T) {
	dir := t.TempDir()
	globalFile := filepath.Join(dir, "global_known_hosts")
	key := khTestKeyEd25519(t)
	line := "corp.example.com " + key.Type() + " " + khKeyB64(key) + "\n"
	if err := os.WriteFile(globalFile, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewKnownHostsStore(filepath.Join(dir, "known_hosts"), globalFile)
	khExpectVerdict(t, store.Verify("corp.example.com", 22, key), KnownHostVerdict{State: KnownHostOk})
}

// Not in the vitest suite: Record must keep unrelated lines byte-for-byte
// (comments, other hosts, markers) while replacing only stale entries.
func TestKnownHostsRecordPreservesUnrelatedLines(t *testing.T) {
	userFile, missing := khFreshPaths(t)
	other := khTestKeyEd25519(t)
	stale := khTestKeyEd25519(t)
	unrelated := "# comment line\n" +
		"other.example.com " + other.Type() + " " + khKeyB64(other) + "\n" +
		"@revoked example.com " + other.Type() + " " + khKeyB64(other) + "\n"
	content := unrelated + "example.com " + stale.Type() + " " + khKeyB64(stale) + "\n"
	if err := os.WriteFile(userFile, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewKnownHostsStore(userFile, missing)
	fresh := khTestKeyEd25519(t)
	if err := store.Record("example.com", 22, fresh); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(userFile)
	if err != nil {
		t.Fatal(err)
	}
	want := unrelated + "example.com " + fresh.Type() + " " + khKeyB64(fresh) + "\n"
	if string(text) != want {
		t.Fatalf("rewritten file = %q, want %q", text, want)
	}
}
