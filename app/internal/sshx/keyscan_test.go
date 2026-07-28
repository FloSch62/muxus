package sshx

// key-scan.ts has no dedicated vitest file; these cases exercise the ported
// behaviors directly: private-key header detection, the skip-file patterns,
// encrypted-or-not probing, .pub sibling merging and agent cross-referencing.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

func scanWriteKey(t *testing.T, dir, name, comment string, passphrase []byte) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var block *pem.Block
	if len(passphrase) > 0 {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, comment, passphrase)
	} else {
		block, err = ssh.MarshalPrivateKey(priv, comment)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	return priv
}

func scanWritePub(t *testing.T, dir, name string, priv ed25519.PrivateKey, comment string) ssh.PublicKey {
	t.Helper()
	pub, err := ssh.NewPublicKey(priv.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
	if comment != "" {
		line += " " + comment
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return pub
}

func TestKeyScanDiscoversPrivateKeys(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "")
	dir := t.TempDir()

	scanWriteKey(t, dir, "id_ed25519", "alice@example", nil)
	lockedPriv := scanWriteKey(t, dir, "id_locked", "ignored", []byte("secret"))
	scanWritePub(t, dir, "id_locked.pub", lockedPriv, "work laptop")

	// Definitely-not-keys and unusable files.
	for name, content := range map[string]string{
		"config":          "Host example\n  User root\n",
		"known_hosts":     "example.com ssh-ed25519 AAAA\n",
		"authorized_keys": "ssh-ed25519 AAAA\n",
		"notes.txt":       "just some text\n",
		"muxus-cache":     "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
		"corrupt":         "-----BEGIN OPENSSH PRIVATE KEY-----\n!!!not base64!!!\n-----END OPENSSH PRIVATE KEY-----\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	res := ListSshKeys(dir)
	if res.AgentAvailable {
		t.Fatal("agentAvailable should be false without SSH_AUTH_SOCK")
	}
	if len(res.AgentKeys) != 0 {
		t.Fatalf("agentKeys = %v, want empty", res.AgentKeys)
	}
	if len(res.Keys) != 2 {
		t.Fatalf("keys = %+v, want 2 entries", res.Keys)
	}

	first := res.Keys[0]
	if first.Name != "id_ed25519" || first.Path != filepath.Join(dir, "id_ed25519") {
		t.Fatalf("first key = %+v", first)
	}
	if first.Type != "ssh-ed25519" || first.Comment != "alice@example" || first.Encrypted || first.InAgent {
		t.Fatalf("first key = %+v", first)
	}

	second := res.Keys[1]
	if second.Name != "id_locked" || !second.Encrypted {
		t.Fatalf("second key = %+v", second)
	}
	// Type and comment come from the .pub sibling for encrypted keys.
	if second.Type != "ssh-ed25519" || second.Comment != "work laptop" || second.InAgent {
		t.Fatalf("second key = %+v", second)
	}
}

func TestKeyScanMissingDir(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "")
	res := ListSshKeys(filepath.Join(t.TempDir(), "does-not-exist"))
	if len(res.Keys) != 0 || len(res.AgentKeys) != 0 || res.AgentAvailable {
		t.Fatalf("response = %+v, want empty", res)
	}
}

func TestKeyScanSkipsOversizeAndDirectories(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "")
	dir := t.TempDir()

	big := append([]byte("-----BEGIN OPENSSH PRIVATE KEY-----\n"), make([]byte, scanMaxKeyFileBytes+1)...)
	if err := os.WriteFile(filepath.Join(dir, "id_big"), big, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "id_dir"), 0o700); err != nil {
		t.Fatal(err)
	}

	res := ListSshKeys(dir)
	if len(res.Keys) != 0 {
		t.Fatalf("keys = %+v, want none", res.Keys)
	}
}

// scanAgentSocketPath returns a socket path short enough for AF_UNIX.
func scanAgentSocketPath(t *testing.T) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "agent.sock")
	if len(sock) < 90 {
		return sock
	}
	dir, err := os.MkdirTemp("/tmp", "sshx-agent-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "agent.sock")
}

func TestKeyScanBadgesAgentKeys(t *testing.T) {
	dir := t.TempDir()
	loadedPriv := scanWriteKey(t, dir, "id_loaded", "in-agent", nil)
	scanWriteKey(t, dir, "id_other", "not-loaded", nil)

	keyring := agent.NewKeyring()
	if err := keyring.Add(agent.AddedKey{PrivateKey: loadedPriv, Comment: "in-agent"}); err != nil {
		t.Fatal(err)
	}
	sock := scanAgentSocketPath(t)
	listener, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go agent.ServeAgent(keyring, conn)
		}
	}()
	t.Setenv("SSH_AUTH_SOCK", sock)

	loadedPub, err := ssh.NewPublicKey(loadedPriv.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}

	res := ListSshKeys(dir)
	if !res.AgentAvailable {
		t.Fatal("agentAvailable should be true")
	}
	if len(res.AgentKeys) != 1 {
		t.Fatalf("agentKeys = %+v, want 1", res.AgentKeys)
	}
	ak := res.AgentKeys[0]
	if ak.Type != "ssh-ed25519" || ak.Comment != "in-agent" || ak.Fingerprint != ssh.FingerprintSHA256(loadedPub) {
		t.Fatalf("agent key = %+v", ak)
	}
	if len(res.Keys) != 2 {
		t.Fatalf("keys = %+v, want 2", res.Keys)
	}
	if !res.Keys[0].InAgent || res.Keys[0].Name != "id_loaded" {
		t.Fatalf("loaded key not badged: %+v", res.Keys[0])
	}
	if res.Keys[1].InAgent {
		t.Fatalf("unloaded key badged: %+v", res.Keys[1])
	}
}
