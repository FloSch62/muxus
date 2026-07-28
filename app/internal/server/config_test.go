package server

import "testing"

// Cases ported from tests/unit/server/config.test.ts.
func TestResolveConfigDefaults(t *testing.T) {
	a := ResolveConfig(Overrides{})
	b := ResolveConfig(Overrides{})
	if a.Host != "127.0.0.1" {
		t.Fatalf("host = %q", a.Host)
	}
	if a.Port != 3002 {
		t.Fatalf("port = %d", a.Port)
	}
	if len(a.Token) != 32 {
		t.Fatalf("token length = %d, want 32", len(a.Token))
	}
	if a.Token == b.Token {
		t.Fatal("tokens must be fresh per run")
	}
}

func TestResolveConfigDevToken(t *testing.T) {
	if got := ResolveConfig(Overrides{DevToken: "dev"}).Token; got != "dev" {
		t.Fatalf("token = %q, want dev", got)
	}
}

func TestResolveConfigOverrides(t *testing.T) {
	port := 0
	openBrowser := false
	cfg := ResolveConfig(Overrides{Port: &port, OpenBrowser: &openBrowser, StaticRoot: "/tmp/x"})
	if cfg.Port != 0 {
		t.Fatalf("port = %d, want 0", cfg.Port)
	}
	if cfg.OpenBrowser {
		t.Fatal("openBrowser must be overridable to false")
	}
	if cfg.StaticRoot != "/tmp/x" {
		t.Fatalf("staticRoot = %q", cfg.StaticRoot)
	}
}
