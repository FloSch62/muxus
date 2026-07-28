package sshx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FloSch62/muxus/app/internal/api"
)

// FuzzConfigEditRoundTrip asserts the two properties the editor's safety
// rests on: (1) parse + serialize is byte-lossless for any config already in
// canonical form (LF line endings, trailing newline — the only form the
// serializer emits), and (2) once a Host block has been canonicalized by one
// no-op upsert, further no-op upserts are byte-identical.
func FuzzConfigEditRoundTrip(f *testing.F) {
	f.Add("Host web\n  HostName web.example.com\n  User deploy\n  Port 2222\n")
	f.Add("# banner\nHost *\n\tServerAliveInterval 60\n\nHost db\n\tHostName db.internal\n")
	f.Add("# my app\nHost app w-* !w-3\n  ProxyJump bastion\n  IdentityFile ~/.ssh/app\n  LocalForward 8080 localhost:80\n  Compression yes\n")
	f.Add("User global\n\nHost a b\n  HostName \"a b\"\n\nMatch host a\n  User matched\n")
	f.Add("\n")
	f.Fuzz(func(t *testing.T, input string) {
		if len(input) == 0 || len(input) > 4096 {
			return
		}
		// The serializer canonicalizes to LF with one trailing newline; only
		// inputs already in that form can round-trip byte-identically.
		if strings.ContainsRune(input, '\r') || !strings.HasSuffix(input, "\n") {
			return
		}
		// Include may reach files outside the sandbox; keep the corpus
		// self-contained.
		if strings.Contains(strings.ToLower(input), "include") {
			return
		}

		root := filepath.Join(t.TempDir(), ".ssh", "config")
		if err := os.MkdirAll(filepath.Dir(root), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(root, []byte(input), 0o600); err != nil {
			t.Fatal(err)
		}

		doc := LoadConfigDocument(root)
		if err := cfgWriteConfigFile(root, doc.Files[doc.RootPath]); err != nil {
			t.Fatal(err)
		}
		after, err := os.ReadFile(root)
		if err != nil {
			t.Fatal(err)
		}
		if string(after) != input {
			t.Fatalf("parse+serialize not byte-identical:\n in: %q\nout: %q", input, after)
		}

		hosts := ListHosts(doc)
		if len(hosts) == 0 || hosts[0].File != doc.RootPath {
			return
		}
		h := hosts[0]
		req := api.HostUpsertRequest{Aliases: h.Aliases, Description: h.Description, Options: h.Options, PreviousAlias: h.Alias}
		if _, err := UpsertHost(req, root); err != nil {
			// The validator rejects some parseable-but-exotic blocks; that is
			// fine, only successful edits must be stable.
			return
		}
		canonical, err := os.ReadFile(root)
		if err != nil {
			t.Fatal(err)
		}

		var again *api.SSHHostEntry
		for _, e := range ListHosts(LoadConfigDocument(root)) {
			if e.Alias == h.Alias {
				again = &e
				break
			}
		}
		if again == nil {
			t.Fatalf("host %q vanished after a no-op upsert of:\n%q", h.Alias, input)
		}
		req = api.HostUpsertRequest{Aliases: again.Aliases, Description: again.Description, Options: again.Options, PreviousAlias: again.Alias}
		if _, err := UpsertHost(req, root); err != nil {
			t.Fatalf("second no-op upsert rejected (%v) for:\n%q", err, input)
		}
		final, err := os.ReadFile(root)
		if err != nil {
			t.Fatal(err)
		}
		if string(final) != string(canonical) {
			t.Fatalf("no-op upsert not idempotent for:\n%q\nfirst:  %q\nsecond: %q", input, canonical, final)
		}
	})
}
