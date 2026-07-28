package server

import (
	"fmt"
	"net/url"
	"strings"
)

// Subprotocol constants mirror shared/src/ws-protocol.ts.
const (
	// TerminalWSProtocol is the fixed subprotocol the server selects.
	TerminalWSProtocol = "muxus.terminal.v1"
	// TerminalWSAuthPrefix carries the bearer token as a non-selected
	// subprotocol so it stays out of request URLs.
	TerminalWSAuthPrefix = "muxus.auth."
)

// WebsocketHeaderHasToken authenticates a WebSocket upgrade from its
// Sec-WebSocket-Protocol header without putting the token in the URL.
func WebsocketHeaderHasToken(header []string, token string) bool {
	expected := TerminalWSAuthPrefix + token
	for _, raw := range header {
		for _, protocol := range strings.Split(raw, ",") {
			if strings.TrimSpace(protocol) == expected {
				return true
			}
		}
	}
	return false
}

// OriginAllowed implements the DNS-rebinding defense: only same-host browser
// pages (or non-browser clients without an Origin header) may open sockets.
func OriginAllowed(origin string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "127.0.0.1" || host == "localhost"
}

// URLs mirrors ServerUrls: PublicURL is safe to display and log; BrowserURL
// bootstraps a standalone browser via the fragment, which never reaches HTTP
// servers.
type URLs struct {
	PublicURL  string
	BrowserURL string
}

func ServerURLs(host string, port int, token string) URLs {
	publicURL := fmt.Sprintf("http://%s:%d/", host, port)
	return URLs{
		PublicURL:  publicURL,
		BrowserURL: publicURL + "#token=" + url.QueryEscape(token),
	}
}
