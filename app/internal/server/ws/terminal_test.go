package ws

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/localpty"
	"github.com/FloSch62/muxus/app/internal/server"
)

const testToken = "terminal-ws-test-token"

func newTerminalServer(t *testing.T) *httptest.Server {
	t.Helper()
	cfg := server.ResolveConfig(server.Overrides{DevToken: testToken, StaticRoot: "/nonexistent"})
	ctx := &server.Context{Config: cfg, Log: slog.Default()}
	deps := &Deps{
		SpawnLocalPty: func(profile *api.LocalProfile, cols, rows int) (LocalPty, string, error) {
			pty, err := localpty.Spawn(profile, cols, rows)
			if err != nil {
				return nil, "", err
			}
			return pty, pty.Shell, nil
		},
		Log: slog.Default(),
	}
	router := server.NewRouter(ctx, func(r chi.Router) {
		RegisterTerminalSocket(r, ctx, deps)
	})
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	return srv
}

func dialTerminal(t *testing.T, srv *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/terminal"
	dialer := websocket.Dialer{Subprotocols: []string{server.TerminalWSProtocol, server.TerminalWSAuthPrefix + token}}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

type serverFrame struct {
	binary  []byte
	control map[string]any
}

func readFrame(t *testing.T, conn *websocket.Conn) serverFrame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	msgType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if msgType == websocket.BinaryMessage {
		return serverFrame{binary: data}
	}
	var control map[string]any
	if err := json.Unmarshal(data, &control); err != nil {
		t.Fatalf("control frame not JSON: %q", data)
	}
	return serverFrame{control: control}
}

// awaitControl reads frames until the wanted op arrives, collecting binary
// output on the way.
func awaitControl(t *testing.T, conn *websocket.Conn, op string, output *strings.Builder) map[string]any {
	t.Helper()
	for i := 0; i < 500; i++ {
		frame := readFrame(t, conn)
		if frame.binary != nil {
			if output != nil {
				output.Write(frame.binary)
			}
			continue
		}
		if frame.control["op"] == op {
			return frame.control
		}
	}
	t.Fatalf("no %q control frame arrived", op)
	return nil
}

func TestRejectsUpgradeWithoutToken(t *testing.T) {
	srv := newTerminalServer(t)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/terminal"
	dialer := websocket.Dialer{Subprotocols: []string{server.TerminalWSProtocol}}
	_, resp, err := dialer.Dial(url, nil)
	if err == nil {
		t.Fatal("dial must fail without the auth subprotocol")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 handshake rejection, got %+v", resp)
	}
}

func TestLocalShellSessionLifecycle(t *testing.T) {
	srv := newTerminalServer(t)
	conn := dialTerminal(t, srv, testToken)

	connect := map[string]any{
		"op":      "connect",
		"profile": map[string]any{"kind": "local", "shell": "/bin/sh"},
		"cols":    80,
		"rows":    24,
	}
	payload, _ := json.Marshal(connect)
	if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatal(err)
	}

	logging := awaitControl(t, conn, "logging-state", nil)
	if logging["enabled"] != false {
		t.Fatalf("noop recorder must report logging disabled: %v", logging)
	}
	ready := awaitControl(t, conn, "ready", nil)
	connID, _ := ready["connId"].(string)
	if !strings.HasPrefix(connID, "local-") {
		t.Fatalf("connId = %q, want local-<pid>", connID)
	}

	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("echo muxus-e2e-$((20+22))\n")); err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(output.String(), "muxus-e2e-42") {
		if time.Now().After(deadline) {
			t.Fatalf("marker never echoed; output so far: %q", output.String())
		}
		frame := readFrame(t, conn)
		if frame.binary != nil {
			output.Write(frame.binary)
		}
	}

	resize, _ := json.Marshal(map[string]any{"op": "resize", "cols": 120, "rows": 40})
	if err := conn.WriteMessage(websocket.TextMessage, resize); err != nil {
		t.Fatal(err)
	}

	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("exit\n")); err != nil {
		t.Fatal(err)
	}
	exit := awaitControl(t, conn, "exit", &output)
	if exit["reason"] != "completed" {
		t.Fatalf("exit reason = %v, want completed", exit["reason"])
	}
	if code, ok := exit["code"].(float64); !ok || code != 0 {
		t.Fatalf("exit code = %v, want 0", exit["code"])
	}
}

func TestSetLoggingRoundTrip(t *testing.T) {
	srv := newTerminalServer(t)
	conn := dialTerminal(t, srv, testToken)

	connect, _ := json.Marshal(map[string]any{
		"op":      "connect",
		"profile": map[string]any{"kind": "local", "shell": "/bin/sh"},
		"cols":    80,
		"rows":    24,
	})
	if err := conn.WriteMessage(websocket.TextMessage, connect); err != nil {
		t.Fatal(err)
	}
	awaitControl(t, conn, "ready", nil)

	setLogging, _ := json.Marshal(map[string]any{"op": "set-logging", "paused": true})
	if err := conn.WriteMessage(websocket.TextMessage, setLogging); err != nil {
		t.Fatal(err)
	}
	state := awaitControl(t, conn, "logging-state", nil)
	if state["paused"] != true {
		t.Fatalf("logging-state after set-logging = %v, want paused=true", state)
	}
}
