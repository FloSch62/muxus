package routes

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/history"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/server"
)

func sessionHistoryTestApp(t *testing.T) (http.Handler, string) {
	t.Helper()
	root := t.TempDir()
	db, err := persist.Open(filepath.Join(root, "muxus.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	settings, err := db.SessionHistorySettings()
	if err != nil {
		t.Fatal(err)
	}
	store, err := history.Open(history.Options{
		Root: filepath.Join(root, "history"), Settings: settings,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = store.Close()
		_ = db.Close()
	})

	policy := history.PartPolicy{MaxPartBytes: 64 * 1024, MaxParts: 2}
	id := store.BeginSession(history.SessionLogCreateInput{
		ProfileKey: "ssh:edge", Title: "Edge / Router", Kind: "ssh", Host: "edge",
		StartedAt: "2026-07-24T10:00:00Z",
	}, policy)
	store.Append(id, []history.HistoryEvent{{
		Sequence: 1, RecordedAt: "2026-07-24T10:00:01Z", ElapsedMs: 1000,
		Direction: "output", Raw: []byte("\x1b[31mUP\x1b[0m\r\n"), Text: "UP\n",
	}}, policy)
	store.FinishSession(id, "completed", "2026-07-24T10:01:00Z")

	cfg := server.ResolveConfig(server.Overrides{
		DevToken: testToken, StaticRoot: "/does/not/exist",
		DatabasePath: filepath.Join(root, "muxus.sqlite3"),
	})
	ctx := &server.Context{Config: cfg, Database: db, History: store}
	app := server.NewRouter(ctx, func(r chi.Router) {
		RegisterSessionHistoryRoutes(r, ctx)
	})
	return app, id
}

func TestSessionHistoryRoutesListExportPinAndDelete(t *testing.T) {
	app, id := sessionHistoryTestApp(t)

	list := request(t, app, http.MethodGet, "/api/session-history?query=UP&limit=10", nil, true)
	if list.Code != http.StatusOK {
		t.Fatalf("list = %d %s", list.Code, list.Body.String())
	}
	var listed struct {
		Sessions []struct {
			ID string `json:"id"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Sessions) != 1 || listed.Sessions[0].ID != id {
		t.Fatalf("sessions = %+v", listed.Sessions)
	}

	clean := request(t, app, http.MethodGet, "/api/session-history/"+id+"/clean", nil, true)
	if clean.Code != http.StatusOK || !strings.Contains(clean.Body.String(), "UP\n") {
		t.Fatalf("clean = %d %q", clean.Code, clean.Body.String())
	}
	if disposition := clean.Header().Get("Content-Disposition"); !strings.Contains(disposition, "edge-router-clean.txt") {
		t.Fatalf("Content-Disposition = %q", disposition)
	}

	raw := request(t, app, http.MethodGet, "/api/session-history/"+id+"/raw", nil, true)
	if raw.Code != http.StatusOK || !strings.Contains(raw.Body.String(), `"encoding":"base64"`) {
		t.Fatalf("raw = %d %q", raw.Code, raw.Body.String())
	}

	pinned := request(t, app, http.MethodPut, "/api/session-history/"+id+"/pin",
		map[string]any{"pinned": true}, true)
	if pinned.Code != http.StatusOK || decodeBody(t, pinned)["updated"] != true {
		t.Fatalf("pin = %d %s", pinned.Code, pinned.Body.String())
	}
	deleted := request(t, app, http.MethodDelete, "/api/session-history/"+id, nil, true)
	if deleted.Code != http.StatusOK || decodeBody(t, deleted)["deleted"] != true {
		t.Fatalf("delete = %d %s", deleted.Code, deleted.Body.String())
	}
}

func TestSessionHistoryRoutesValidateAuthAndQuery(t *testing.T) {
	app, _ := sessionHistoryTestApp(t)
	if rec := request(t, app, http.MethodGet, "/api/session-history", nil, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", rec.Code)
	}
	if rec := request(t, app, http.MethodGet, "/api/session-history?kind=ftp", nil, true); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid kind status = %d", rec.Code)
	}
	if rec := request(t, app, http.MethodGet, "/api/session-history?limit=101", nil, true); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid limit status = %d", rec.Code)
	}
}
