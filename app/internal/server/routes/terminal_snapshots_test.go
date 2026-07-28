package routes

import (
	"net/http"
	"reflect"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/persist"
)

func newSnapshotTestApp(t *testing.T) http.Handler {
	t.Helper()
	return newDBTestApp(t, func(r chi.Router, db *persist.DB) {
		RegisterTerminalSnapshotRoutes(r, db)
	})
}

// Ported from tests/unit/server/terminal-snapshot-routes.test.ts.
func TestTerminalSnapshotRoundTripsForTab(t *testing.T) {
	app := newSnapshotTestApp(t)
	data := "deploy@web-01:~$ uptime\r\n 09:15 up 42 days"

	put := request(t, app, http.MethodPut, "/api/terminal-snapshots/tab-1",
		map[string]any{"data": data}, true)
	if put.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", put.Code, put.Body.String())
	}
	if !reflect.DeepEqual(decodeBody(t, put), map[string]any{"saved": true}) {
		t.Fatalf("put body = %s", put.Body.String())
	}

	get := request(t, app, http.MethodGet, "/api/terminal-snapshots/tab-1", nil, true)
	if get.Code != http.StatusOK {
		t.Fatalf("get status = %d", get.Code)
	}
	snapshot, ok := decodeBody(t, get)["snapshot"].(map[string]any)
	if !ok {
		t.Fatalf("get body = %s", get.Body.String())
	}
	if snapshot["tabId"] != "tab-1" || snapshot["data"] != data {
		t.Fatalf("snapshot = %v", snapshot)
	}
}

func TestTerminalSnapshotAnswersNullForUnknownTab(t *testing.T) {
	app := newSnapshotTestApp(t)
	get := request(t, app, http.MethodGet, "/api/terminal-snapshots/never-seen", nil, true)
	if get.Code != http.StatusOK {
		t.Fatalf("status = %d", get.Code)
	}
	if !reflect.DeepEqual(decodeBody(t, get), map[string]any{"snapshot": nil}) {
		t.Fatalf("body = %s", get.Body.String())
	}
}

func TestTerminalSnapshotRejectsEmptyAndMalformed(t *testing.T) {
	app := newSnapshotTestApp(t)

	empty := request(t, app, http.MethodPut, "/api/terminal-snapshots/tab-1",
		map[string]any{"data": ""}, true)
	if empty.Code != http.StatusBadRequest {
		t.Fatalf("empty status = %d, want 400", empty.Code)
	}

	wrongShape := request(t, app, http.MethodPut, "/api/terminal-snapshots/tab-1",
		map[string]any{"scrollback": "not the field"}, true)
	if wrongShape.Code != http.StatusBadRequest {
		t.Fatalf("wrong-shape status = %d, want 400", wrongShape.Code)
	}
}

func TestTerminalSnapshotRequiresBearerToken(t *testing.T) {
	app := newSnapshotTestApp(t)
	rec := request(t, app, http.MethodGet, "/api/terminal-snapshots/tab-1", nil, false)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
