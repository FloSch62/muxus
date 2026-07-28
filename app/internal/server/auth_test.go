package server

import (
	"net/url"
	"strings"
	"testing"
)

// Cases ported from tests/unit/server/auth.test.ts.
func TestWebsocketHeaderHasToken(t *testing.T) {
	if !WebsocketHeaderHasToken([]string{"muxus.terminal.v1, muxus.auth.secret"}, "secret") {
		t.Fatal("exact auth protocol among offered protocols must be accepted")
	}
	for _, header := range [][]string{
		nil,
		{"muxus.terminal.v1, muxus.auth.sec"},
		{"muxus.terminal.v1, muxus.auth.other"},
	} {
		if WebsocketHeaderHasToken(header, "secret") {
			t.Fatalf("header %v must be rejected", header)
		}
	}
}

func TestServerURLsKeepCredentialsOutOfHTTPPortions(t *testing.T) {
	urls := ServerURLs("127.0.0.1", 4321, "top-secret")
	if urls.PublicURL != "http://127.0.0.1:4321/" {
		t.Fatalf("public URL = %q", urls.PublicURL)
	}
	if strings.Contains(urls.PublicURL, "top-secret") {
		t.Fatal("public URL must not contain the token")
	}
	bootstrap, err := url.Parse(urls.BrowserURL)
	if err != nil {
		t.Fatal(err)
	}
	if bootstrap.RawQuery != "" {
		t.Fatalf("browser URL query = %q, want empty", bootstrap.RawQuery)
	}
	if bootstrap.Fragment != "token=top-secret" {
		t.Fatalf("browser URL fragment = %q", bootstrap.Fragment)
	}
}

func TestOriginAllowed(t *testing.T) {
	for origin, want := range map[string]bool{
		"":                        true,
		"http://127.0.0.1:39871":  true,
		"http://localhost:5174":   true,
		"http://evil.example.com": false,
		"not a url":               false,
	} {
		if got := OriginAllowed(origin); got != want {
			t.Fatalf("OriginAllowed(%q) = %v, want %v", origin, got, want)
		}
	}
}
