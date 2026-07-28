package sshx

// Ported 1:1 from tests/unit/server/ssh-config.test.ts; the fixture strings
// are copied verbatim.

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/FloSch62/muxus/app/internal/api"
)

func cfgTestWrite(t *testing.T, dir, name, content string) string {
	t.Helper()
	file := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

func cfgTestDoc(t *testing.T, content string) *ConfigDocument {
	t.Helper()
	return LoadConfigDocument(cfgTestWrite(t, t.TempDir(), "config", content))
}

func cfgTestHosts(t *testing.T, content string) []api.SSHHostEntry {
	t.Helper()
	return ListHosts(cfgTestDoc(t, content))
}

func cfgTestEqual(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s = %#v, want %#v", what, got, want)
	}
}

func TestListHostsConcreteWithOptionsAndResolved(t *testing.T) {
	hosts := cfgTestHosts(t, strings.Join([]string{"# Production web server", "# behind the LB", "Host web", "  HostName web.example.com", "  User deploy", "  Port 2222"}, "\n"))
	if len(hosts) != 1 {
		t.Fatalf("got %d hosts, want 1", len(hosts))
	}
	web := hosts[0]
	cfgTestEqual(t, "alias", web.Alias, "web")
	cfgTestEqual(t, "description", web.Description, "Production web server\nbehind the LB")
	cfgTestEqual(t, "options.hostname", *web.Options.Hostname, "web.example.com")
	cfgTestEqual(t, "options.user", *web.Options.User, "deploy")
	cfgTestEqual(t, "options.port", *web.Options.Port, 2222)
	cfgTestEqual(t, "resolved.hostname", web.Resolved.Hostname, "web.example.com")
	cfgTestEqual(t, "resolved.user", web.Resolved.User, "deploy")
	cfgTestEqual(t, "resolved.port", web.Resolved.Port, 2222)
	cfgTestEqual(t, "resolved.proxyJump", web.Resolved.ProxyJump, []string{})
	cfgTestEqual(t, "resolved.forwards", web.Resolved.Forwards, []api.ConfigForward{})
}

func TestListHostsMultiAliasSkipsWildcards(t *testing.T) {
	hosts := cfgTestHosts(t, strings.Join([]string{"Host db db.example.com backup-*", "  User admin", "", "Host *", "  Port 2200"}, "\n"))
	if len(hosts) != 1 {
		t.Fatalf("got %d hosts, want 1", len(hosts))
	}
	cfgTestEqual(t, "alias", hosts[0].Alias, "db")
	cfgTestEqual(t, "aliases", hosts[0].Aliases, []string{"db", "db.example.com"})
	cfgTestEqual(t, "resolved.port", hosts[0].Resolved.Port, 2200) // Host * default applied
	if hosts[0].Options.Port != nil {                              // …but not written in the block
		t.Fatalf("options.port = %v, want absent", *hosts[0].Options.Port)
	}
}

func TestListHostsExtrasOrderPreserved(t *testing.T) {
	hosts := cfgTestHosts(t, strings.Join([]string{"Host a", "  Compression yes", "  HostName a.example.com", "  ServerAliveCountMax 5"}, "\n"))
	cfgTestEqual(t, "extras", hosts[0].Options.Extras, []api.HostExtraOption{
		{Keyword: "Compression", Value: "yes"},
		{Keyword: "ServerAliveCountMax", Value: "5"},
	})
}

func TestListHostsForwardsProxyJumpsAndAuth(t *testing.T) {
	hosts := cfgTestHosts(t, strings.Join([]string{
		"Host app",
		"  ProxyJump bastion,ops@edge:2200",
		"  IdentityFile ~/.ssh/app_key",
		"  CertificateFile ~/.ssh/app_key-cert.pub",
		"  IdentitiesOnly yes",
		"  ForwardAgent yes",
		"  LocalForward 8080 localhost:80",
		"  LocalForward 127.0.0.1:8443 [::1]:443",
		"  RemoteForward 9000 127.0.0.1:3000",
		"  DynamicForward 1080",
	}, "\n"))
	app := hosts[0]
	cfgTestEqual(t, "proxyJump", app.Options.ProxyJump, []string{"bastion", "ops@edge:2200"})
	cfgTestEqual(t, "identityFiles", app.Options.IdentityFiles, []string{"~/.ssh/app_key"})
	cfgTestEqual(t, "certificateFiles", app.Options.CertificateFiles, []string{"~/.ssh/app_key-cert.pub"})
	cfgTestEqual(t, "identitiesOnly", *app.Options.IdentitiesOnly, true)
	cfgTestEqual(t, "forwardAgent", *app.Options.ForwardAgent, true)
	cfgTestEqual(t, "forwards", app.Options.Forwards, []api.ConfigForward{
		{Type: "local", BindPort: 8080, TargetHost: "localhost", TargetPort: 80},
		{Type: "local", BindPort: 8443, TargetHost: "::1", TargetPort: 443},
		{Type: "remote", BindPort: 9000, TargetHost: "127.0.0.1", TargetPort: 3000},
		{Type: "dynamic", BindPort: 1080},
	})
	home, _ := os.UserHomeDir()
	cfgTestEqual(t, "resolved.identityFiles", app.Resolved.IdentityFiles, []string{filepath.Join(home, ".ssh", "app_key")})
	cfgTestEqual(t, "resolved.certificateFiles", app.Resolved.CertificateFiles, []string{filepath.Join(home, ".ssh", "app_key-cert.pub")})
}

func TestListHostsProxyCommandFirstClass(t *testing.T) {
	hosts := cfgTestHosts(t, strings.Join([]string{"Host cloud", "  ProxyCommand cloudflared access ssh --hostname %h"}, "\n"))
	cfgTestEqual(t, "proxyCommand", *hosts[0].Options.ProxyCommand, "cloudflared access ssh --hostname %h")
	if hosts[0].Options.Extras != nil {
		t.Fatalf("extras = %#v, want absent", hosts[0].Options.Extras)
	}
}

func TestListHostsPubkeyAuthenticationNoMapsToPasswordOnly(t *testing.T) {
	hosts := cfgTestHosts(t, strings.Join([]string{"Host legacy", "  PubkeyAuthentication no", "  PreferredAuthentications keyboard-interactive,password"}, "\n"))
	cfgTestEqual(t, "passwordOnly", hosts[0].Options.PasswordOnly, true)
	if hosts[0].Options.Extras != nil {
		t.Fatalf("extras = %#v, want absent", hosts[0].Options.Extras)
	}
	cfgTestEqual(t, "resolved.passwordOnly", hosts[0].Resolved.PasswordOnly, true)
}

func TestResolveHostFirstObtainedWins(t *testing.T) {
	doc := cfgTestDoc(t, strings.Join([]string{"User global-user", "", "Host web", "  Port 2222", "", "Host web", "  Port 9999", "  HostName real.example.com", "", "Host *", "  User star-user"}, "\n"))
	r := ResolveHost(doc, "web")
	cfgTestEqual(t, "user", r.User, "global-user")              // top-level option read first
	cfgTestEqual(t, "port", r.Port, 2222)                       // first block wins
	cfgTestEqual(t, "hostname", r.Hostname, "real.example.com") // first obtained anywhere
}

func TestResolveHostAccumulatesIdentityFilesDeduped(t *testing.T) {
	doc := cfgTestDoc(t, strings.Join([]string{"Host web", "  IdentityFile /a", "", "Host *", "  IdentityFile /b", "  IdentityFile /a"}, "\n"))
	cfgTestEqual(t, "identityFiles", ResolveHost(doc, "web").IdentityFiles, []string{"/a", "/b"})
}

func TestResolveHostCertificateFilesAndProxyCommand(t *testing.T) {
	doc := cfgTestDoc(t, strings.Join([]string{
		"Host web",
		"  CertificateFile ~/.ssh/web-cert.pub",
		"  ProxyCommand connect-proxy %h %p",
		"",
		"Host *",
		"  CertificateFile /shared-cert.pub",
		"  CertificateFile ~/.ssh/web-cert.pub",
		"  ProxyJump ignored-because-proxy-command-won",
	}, "\n"))
	resolved := ResolveHost(doc, "web")
	home, _ := os.UserHomeDir()
	cfgTestEqual(t, "certificateFiles", resolved.CertificateFiles, []string{
		filepath.Join(home, ".ssh", "web-cert.pub"),
		"/shared-cert.pub",
	})
	cfgTestEqual(t, "proxyCommand", resolved.ProxyCommand, "connect-proxy %h %p")
	cfgTestEqual(t, "proxyJump", resolved.ProxyJump, []string{})
}

func TestResolveHostProxyJumpWinsWhenObtainedFirst(t *testing.T) {
	doc := cfgTestDoc(t, strings.Join([]string{
		"Host web",
		"  ProxyJump bastion",
		"",
		"Host *",
		"  ProxyCommand ignored %h %p",
	}, "\n"))
	resolved := ResolveHost(doc, "web")
	cfgTestEqual(t, "proxyJump", resolved.ProxyJump, []string{"bastion"})
	cfgTestEqual(t, "proxyCommand", resolved.ProxyCommand, "")
}

func TestResolveHostExpandsHostTokenAndDefaultsHostname(t *testing.T) {
	doc := cfgTestDoc(t, strings.Join([]string{"Host node-1 node-2", "  HostName %h.cluster.internal"}, "\n"))
	cfgTestEqual(t, "hostname", ResolveHost(doc, "node-2").Hostname, "node-2.cluster.internal")
	cfgTestEqual(t, "hostname", ResolveHost(doc, "unknown").Hostname, "unknown")
}

func TestResolveHostHonorsNegatedPatterns(t *testing.T) {
	doc := cfgTestDoc(t, strings.Join([]string{"Host prod-* !prod-3", "  User produser"}, "\n"))
	cfgTestEqual(t, "user", ResolveHost(doc, "prod-1").User, "produser")
	cfgTestEqual(t, "user", ResolveHost(doc, "prod-3").User, "")
}

func TestResolveHostSkipsMatchBlocks(t *testing.T) {
	doc := cfgTestDoc(t, strings.Join([]string{"Host web", "  Port 2222", "", "Match host web", "  User matched", "", "Host web2", "  User plain"}, "\n"))
	cfgTestEqual(t, "user", ResolveHost(doc, "web").User, "")
	cfgTestEqual(t, "user", ResolveHost(doc, "web2").User, "plain")
}

func TestResolveHostReadsTimeoutsAndKeepalive(t *testing.T) {
	doc := cfgTestDoc(t, strings.Join([]string{"Host slow", "  ConnectTimeout 45", "  ServerAliveInterval 30"}, "\n"))
	r := ResolveHost(doc, "slow")
	if r.ConnectTimeout == nil || *r.ConnectTimeout != 45 {
		t.Fatalf("connectTimeout = %v, want 45", r.ConnectTimeout)
	}
	if r.ServerAliveInterval == nil || *r.ServerAliveInterval != 30 {
		t.Fatalf("serverAliveInterval = %v, want 30", r.ServerAliveInterval)
	}
}

func TestResolveHostFollowsIncludes(t *testing.T) {
	dir := t.TempDir()
	inc := cfgTestWrite(t, dir, "conf.d/extra", strings.Join([]string{"Host from-include", "  User inc"}, "\n"))
	doc := LoadConfigDocument(cfgTestWrite(t, dir, "config", strings.Join([]string{"Include " + inc, "", "Host base", "  User base"}, "\n")))
	aliases := []string{}
	for _, h := range ListHosts(doc) {
		aliases = append(aliases, h.Alias)
	}
	sort.Strings(aliases)
	cfgTestEqual(t, "aliases", aliases, []string{"base", "from-include"})
	cfgTestEqual(t, "fileOrder length", len(doc.FileOrder), 2)
}

func TestResolveHostRecordsIncludeErrors(t *testing.T) {
	dir := t.TempDir()
	doc := LoadConfigDocument(cfgTestWrite(t, dir, "config", strings.Join([]string{"Include " + filepath.Join(dir, "nope", "missing"), "Host still-here"}, "\n")))
	if !strings.Contains(doc.Error, "could not read") {
		t.Fatalf("error = %q, want a could-not-read message", doc.Error)
	}
	hosts := ListHosts(doc)
	if len(hosts) != 1 || hosts[0].Alias != "still-here" {
		t.Fatalf("hosts = %#v, want [still-here]", hosts)
	}
}

func TestHostPatternsMatchGlobs(t *testing.T) {
	cfgTestEqual(t, "match", HostPatternsMatch([]string{"*.example.com"}, "a.example.com"), true)
	cfgTestEqual(t, "match", HostPatternsMatch([]string{"prod-?"}, "prod-1"), true)
	cfgTestEqual(t, "match", HostPatternsMatch([]string{"prod-?"}, "prod-12"), false)
	cfgTestEqual(t, "match", HostPatternsMatch([]string{"*", "!secret"}, "secret"), false)
}

func TestParseHostSpec(t *testing.T) {
	cfgTestEqual(t, "spec", ParseHostSpec("web"), HostSpec{Host: "web"})
	cfgTestEqual(t, "spec", ParseHostSpec("root@web"), HostSpec{Host: "web", User: "root"})
	cfgTestEqual(t, "spec", ParseHostSpec("root@web:2222"), HostSpec{Host: "web", User: "root", Port: 2222})
	cfgTestEqual(t, "spec", ParseHostSpec("[::1]:2200"), HostSpec{Host: "::1", Port: 2200})
}

func TestParseProxyJumpList(t *testing.T) {
	cfgTestEqual(t, "list", ParseProxyJumpList("a, b@c:22 ,d"), []string{"a", "b@c:22", "d"})
	cfgTestEqual(t, "list", ParseProxyJumpList("none"), []string{})
	cfgTestEqual(t, "list", ParseProxyJumpList(""), []string{})
}
