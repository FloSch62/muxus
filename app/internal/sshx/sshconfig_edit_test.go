package sshx

// Ported 1:1 from tests/unit/server/ssh-config-edit.test.ts; the fixture
// strings are copied verbatim.

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/FloSch62/muxus/app/internal/api"
)

func cfgStrPtr(v string) *string { return &v }
func cfgIntPtr(v int) *int       { return &v }

// cfgEditFreshRoot is a path for a config whose .ssh directory does not
// exist yet.
func cfgEditFreshRoot(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "home", ".ssh", "config")
}

func cfgEditSeed(t *testing.T, content string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "home", ".ssh")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "config")
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

func cfgEditReq() api.HostUpsertRequest {
	return api.HostUpsertRequest{
		Aliases: []string{"web"},
		Options: api.HostBlockOptions{Hostname: cfgStrPtr("web.example.com"), User: cfgStrPtr("deploy"), Port: cfgIntPtr(2222)},
	}
}

func cfgEditRead(t *testing.T, file string) string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func cfgEditWantErr(t *testing.T, err error, fragment string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), fragment) {
		t.Fatalf("err = %v, want message containing %q", err, fragment)
	}
}

func TestUpsertCreatesConfigWhenNoneExists(t *testing.T) {
	root := cfgEditFreshRoot(t)
	req := cfgEditReq()
	req.Description = "Main web box"
	if _, err := UpsertHost(req, root); err != nil {
		t.Fatal(err)
	}
	text := cfgEditRead(t, root)
	want := strings.Join([]string{"# Main web box", "Host web", "  HostName web.example.com", "  User deploy", "  Port 2222", ""}, "\n")
	if text != want {
		t.Fatalf("text = %q, want %q", text, want)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(root)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %o, want 600", st.Mode().Perm())
		}
	}
}

func TestUpsertAppendsAfterExistingContent(t *testing.T) {
	existing := strings.Join([]string{"# hand-written banner", "Host *", "\tServerAliveInterval 60", "", "Host db", "\tHostName db.internal"}, "\n")
	root := cfgEditSeed(t, existing+"\n")
	if _, err := UpsertHost(cfgEditReq(), root); err != nil {
		t.Fatal(err)
	}
	text := cfgEditRead(t, root)
	if !strings.HasPrefix(text, existing+"\n") {
		t.Fatalf("existing bytes were disturbed:\n%q", text)
	}
	// Indentation style of the file (tabs) is picked up for the new block.
	if !strings.Contains(text, "\tHostName web.example.com") {
		t.Fatalf("text missing tab-indented HostName:\n%q", text)
	}
}

func TestUpsertEditsBlockInPlace(t *testing.T) {
	root := cfgEditSeed(t, strings.Join([]string{"# before", "Host a", "  User alpha", "", "# web comment", "Host web", "  HostName old.example.com", "", "Host z", "  User zed", ""}, "\n"))
	req := cfgEditReq()
	req.PreviousAlias = "web"
	req.Description = "web comment"
	if _, err := UpsertHost(req, root); err != nil {
		t.Fatal(err)
	}
	text := cfgEditRead(t, root)
	want := strings.Join([]string{
		"# before",
		"Host a",
		"  User alpha",
		"",
		"# web comment",
		"Host web",
		"  HostName web.example.com",
		"  User deploy",
		"  Port 2222",
		"",
		"Host z",
		"  User zed",
		"",
	}, "\n")
	if text != want {
		t.Fatalf("text = %q, want %q", text, want)
	}
}

func TestUpsertRenamePreservesWildcardCoPatterns(t *testing.T) {
	root := cfgEditSeed(t, strings.Join([]string{"Host web w-*", "  HostName web.example.com", ""}, "\n"))
	req := cfgEditReq()
	req.Aliases = []string{"website"}
	req.PreviousAlias = "web"
	if _, err := UpsertHost(req, root); err != nil {
		t.Fatal(err)
	}
	if text := cfgEditRead(t, root); !strings.Contains(text, "Host website w-*") {
		t.Fatalf("text missing renamed Host line:\n%q", text)
	}
	if alias := ListHosts(LoadConfigDocument(root))[0].Alias; alias != "website" {
		t.Fatalf("alias = %q, want website", alias)
	}
}

func TestUpsertRejectsExistingAliasInOtherBlock(t *testing.T) {
	root := cfgEditSeed(t, strings.Join([]string{"Host web", "  User a", "", "Host db", "  User b", ""}, "\n"))
	req := cfgEditReq()
	req.Aliases = []string{"db"}
	req.PreviousAlias = "web"
	_, err := UpsertHost(req, root)
	cfgEditWantErr(t, err, "already exists")
	req = cfgEditReq()
	req.Aliases = []string{"web"}
	_, err = UpsertHost(req, root)
	cfgEditWantErr(t, err, "already exists")
}

func TestUpsertRoundTripsListedHost(t *testing.T) {
	root := cfgEditSeed(t, strings.Join([]string{
		"# my app",
		"Host app",
		"  HostName app.example.com",
		"  ProxyJump bastion",
		"  IdentityFile ~/.ssh/app",
		"  CertificateFile ~/.ssh/app-cert.pub",
		"  ProxyCommand custom-proxy %h %p",
		"  LocalForward 8080 localhost:80",
		"  Compression yes",
		"",
	}, "\n"))
	before := ListHosts(LoadConfigDocument(root))[0]
	req := api.HostUpsertRequest{Aliases: before.Aliases, Description: before.Description, Options: before.Options, PreviousAlias: before.Alias}
	if _, err := UpsertHost(req, root); err != nil {
		t.Fatal(err)
	}
	after := ListHosts(LoadConfigDocument(root))[0]
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("semantic drift:\nbefore %#v\nafter  %#v", before, after)
	}
}

func TestUpsertMovesHostToIncludeFile(t *testing.T) {
	root := cfgEditSeed(t, strings.Join([]string{"Host web", "  HostName web.example.com", "", "Host db", "  User b", ""}, "\n"))
	groupFile := filepath.Join(filepath.Dir(root), "config.d", "work")
	req := cfgEditReq()
	req.PreviousAlias = "web"
	req.File = cfgStrPtr(groupFile)
	if _, err := UpsertHost(req, root); err != nil {
		t.Fatal(err)
	}
	rootText := cfgEditRead(t, root)
	if strings.Contains(rootText, "web.example.com") {
		t.Fatalf("root still contains the moved block:\n%q", rootText)
	}
	if !strings.Contains(rootText, "Include "+filepath.Join("config.d", "work")) {
		t.Fatalf("root missing the Include:\n%q", rootText)
	}
	if group := cfgEditRead(t, groupFile); !strings.Contains(group, "HostName web.example.com") {
		t.Fatalf("group file missing the block:\n%q", group)
	}
	hosts := ListHosts(LoadConfigDocument(root))
	aliases := []string{}
	var webFile string
	for _, h := range hosts {
		aliases = append(aliases, h.Alias)
		if h.Alias == "web" {
			webFile = h.File
		}
	}
	sort.Strings(aliases)
	cfgTestEqual(t, "aliases", aliases, []string{"db", "web"})
	cfgTestEqual(t, "web file", webFile, groupFile)
}

func TestUpsertRefusesFilesOutsideRootDir(t *testing.T) {
	root := cfgEditSeed(t, "")
	req := cfgEditReq()
	req.File = cfgStrPtr("/etc/passwd")
	_, err := UpsertHost(req, root)
	cfgEditWantErr(t, err, "must live under")
}

func TestUpsertValidatesAliasesAndExtras(t *testing.T) {
	root := cfgEditSeed(t, "")

	req := cfgEditReq()
	req.Aliases = []string{"has space"}
	_, err := UpsertHost(req, root)
	cfgEditWantErr(t, err, "invalid alias")

	req = cfgEditReq()
	req.Aliases = []string{"star*"}
	_, err = UpsertHost(req, root)
	cfgEditWantErr(t, err, "invalid alias")

	req = cfgEditReq()
	req.Options = api.HostBlockOptions{Extras: []api.HostExtraOption{{Keyword: "Host", Value: "x"}}}
	_, err = UpsertHost(req, root)
	cfgEditWantErr(t, err, "invalid option keyword")

	req = cfgEditReq()
	req.Options = api.HostBlockOptions{Extras: []api.HostExtraOption{{Keyword: "Weird Key", Value: "x"}}}
	_, err = UpsertHost(req, root)
	cfgEditWantErr(t, err, "invalid option keyword")

	req = cfgEditReq()
	req.Options = api.HostBlockOptions{ProxyJump: []string{"bastion"}, ProxyCommand: cfgStrPtr("proxy %h %p")}
	_, err = UpsertHost(req, root)
	cfgEditWantErr(t, err, "mutually exclusive")
}

func TestUpsertKeepsBackupOfPreviousContent(t *testing.T) {
	root := cfgEditSeed(t, strings.Join([]string{"Host web", "  User old", ""}, "\n"))
	req := cfgEditReq()
	req.PreviousAlias = "web"
	if _, err := UpsertHost(req, root); err != nil {
		t.Fatal(err)
	}
	if bak := cfgEditRead(t, root+".muxus.bak"); !strings.Contains(bak, "User old") {
		t.Fatalf("backup = %q, want previous content", bak)
	}
}

func TestDeleteHostRemovesBlockWithPrelude(t *testing.T) {
	root := cfgEditSeed(t, strings.Join([]string{"Host a", "  User alpha", "", "# doomed", "Host web", "  HostName web.example.com", "", "Host z", "  User zed", ""}, "\n"))
	if err := DeleteHost("web", root); err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{"Host a", "  User alpha", "", "Host z", "  User zed", ""}, "\n")
	if text := cfgEditRead(t, root); text != want {
		t.Fatalf("text = %q, want %q", text, want)
	}
}

func TestDeleteHostUnknownAlias404s(t *testing.T) {
	root := cfgEditSeed(t, "Host a\n  User alpha\n")
	err := DeleteHost("nope", root)
	cfgEditWantErr(t, err, "no Host block")
	var problem *ConfigProblem
	if !errors.As(err, &problem) || problem.Status != 404 {
		t.Fatalf("err = %#v, want a 404 ConfigProblem", err)
	}
}

func TestPreviewRendersExactlyWhatUpsertWrites(t *testing.T) {
	root := cfgEditSeed(t, "")
	req := cfgEditReq()
	req.Description = "Web box"
	text, err := PreviewHost(req, root)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{"# Web box", "Host web", "  HostName web.example.com", "  User deploy", "  Port 2222"}, "\n")
	if text != want {
		t.Fatalf("text = %q, want %q", text, want)
	}
	if _, err := os.Stat(root + ".muxus.tmp"); !os.IsNotExist(err) {
		t.Fatalf("preview left a tmp file behind (stat err = %v)", err)
	}
}

func TestPreviewRendersCertificateFileAndProxyCommand(t *testing.T) {
	root := cfgEditSeed(t, "")
	req := cfgEditReq()
	req.Options = api.HostBlockOptions{
		IdentityFiles:    []string{"~/.ssh/app"},
		CertificateFiles: []string{"~/.ssh/app-cert.pub"},
		ProxyCommand:     cfgStrPtr("cloudflared access ssh --hostname %h"),
	}
	text, err := PreviewHost(req, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"  IdentityFile ~/.ssh/app",
		"  CertificateFile ~/.ssh/app-cert.pub",
		"  ProxyCommand cloudflared access ssh --hostname %h",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("text = %q, want it to contain %q", text, want)
		}
	}
}
