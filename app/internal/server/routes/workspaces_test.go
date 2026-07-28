package routes

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"regexp"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/server"
)

// newDBTestApp wires DB-backed route groups around a fresh on-disk database,
// mirroring the buildApp(':memory:') harness in the vitest suites.
func newDBTestApp(t *testing.T, register func(r chi.Router, db *persist.DB)) http.Handler {
	t.Helper()
	db, err := persist.Open(filepath.Join(t.TempDir(), "muxus.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	cfg := server.ResolveConfig(server.Overrides{
		DevToken:   testToken,
		StaticRoot: "/path/that/does/not/exist",
	})
	ctx := &server.Context{Config: cfg}
	return server.NewRouter(ctx, func(r chi.Router) { register(r, db) })
}

// request sends a JSON request; a nil body sends no payload.
func request(t *testing.T, app http.Handler, method, url string, body any, authed bool) *httptest.ResponseRecorder {
	t.Helper()
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal payload: %v", err)
		}
		payload = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, url, payload)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if authed {
		req.Header.Set("Authorization", "Bearer "+testToken)
	}
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %q: %v", rec.Body.String(), err)
	}
	return body
}

// jsonClone normalizes a fixture through JSON so DeepEqual can compare it
// against decoded response bodies (numbers become float64, and so on).
func jsonClone(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return out
}

func newWorkspaceTestApp(t *testing.T) http.Handler {
	t.Helper()
	return newDBTestApp(t, func(r chi.Router, db *persist.DB) {
		RegisterWorkspaceRoutes(r, db)
	})
}

// workspaceLayoutFixture rebuilds the `layout` fixture from the vitest suite;
// callers mutate the fresh copy per test.
func workspaceLayoutFixture() map[string]any {
	return map[string]any{
		"version": 1,
		"root": map[string]any{
			"id":        "split-1",
			"type":      "split",
			"direction": "horizontal",
			"ratio":     0.55,
			"children": []any{
				map[string]any{
					"id":          "pane-1",
					"type":        "pane",
					"activeTabId": "terminal-1",
					"tabs": []any{
						map[string]any{
							"id":             "terminal-1",
							"kind":           "terminal",
							"title":          "Production",
							"profile":        map[string]any{"kind": "ssh", "target": "production"},
							"cwdHint":        "/srv/app",
							"offerReconnect": true,
						},
					},
				},
				map[string]any{
					"id":          "pane-2",
					"type":        "pane",
					"activeTabId": "sftp-1",
					"tabs": []any{
						map[string]any{
							"id":         "sftp-1",
							"kind":       "sftp",
							"title":      "Logs",
							"connection": map[string]any{"source": "openssh", "id": "production"},
							"path":       "/var/log",
						},
					},
				},
			},
		},
		"activePaneId": "pane-1",
	}
}

func layoutPane(t *testing.T, layout map[string]any, index int) map[string]any {
	t.Helper()
	root, ok := layout["root"].(map[string]any)
	if !ok {
		t.Fatal("fixture root is not an object")
	}
	children, ok := root["children"].([]any)
	if !ok {
		t.Fatal("fixture children is not an array")
	}
	pane, ok := children[index].(map[string]any)
	if !ok {
		t.Fatalf("fixture child %d is not an object", index)
	}
	return pane
}

// Ported from tests/unit/server/workspace-routes.test.ts.
func TestWorkspaceRoutesRequirePerRunAPICredential(t *testing.T) {
	app := newWorkspaceTestApp(t)
	rec := request(t, app, http.MethodGet, "/api/workspaces", nil, false)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestWorkspaceRoundTripsVersionedPaneTree(t *testing.T) {
	app := newWorkspaceTestApp(t)
	layout := workspaceLayoutFixture()

	save := request(t, app, http.MethodPut, "/api/workspaces",
		map[string]any{"name": "Daily work", "layout": layout}, true)
	if save.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", save.Code, save.Body.String())
	}
	saved := decodeBody(t, save)
	id, _ := saved["id"].(string)
	if id == "" {
		t.Fatalf("saved id missing: %v", saved)
	}

	read := request(t, app, http.MethodGet, "/api/workspaces/"+id, nil, true)
	if read.Code != http.StatusOK {
		t.Fatalf("read status = %d", read.Code)
	}
	got := decodeBody(t, read)
	if got["id"] != id || got["name"] != "Daily work" {
		t.Fatalf("read = %v", got)
	}
	if !reflect.DeepEqual(got["layout"], jsonClone(t, layout)) {
		t.Fatalf("layout = %v, want %v", got["layout"], layout)
	}
	if !reflect.DeepEqual(got["multiExecGroups"], []any{}) {
		t.Fatalf("multiExecGroups = %v, want []", got["multiExecGroups"])
	}
	if got["isStartup"] != false {
		t.Fatalf("isStartup = %v, want false", got["isStartup"])
	}

	list := request(t, app, http.MethodGet, "/api/workspaces", nil, true)
	workspaces, ok := decodeBody(t, list)["workspaces"].([]any)
	if !ok || len(workspaces) != 1 {
		t.Fatalf("workspaces = %s", list.Body.String())
	}
	summary := workspaces[0].(map[string]any)
	if summary["id"] != id || summary["name"] != "Daily work" {
		t.Fatalf("summary = %v", summary)
	}
	if _, hasLayout := summary["layout"]; hasLayout {
		t.Fatalf("summary must not carry a layout: %v", summary)
	}

	latest := request(t, app, http.MethodGet, "/api/workspaces/latest", nil, true)
	workspace, ok := decodeBody(t, latest)["workspace"].(map[string]any)
	if !ok {
		t.Fatalf("latest = %s", latest.Body.String())
	}
	if workspace["id"] != id || workspace["name"] != "Daily work" {
		t.Fatalf("latest workspace = %v", workspace)
	}
	if !reflect.DeepEqual(workspace["layout"], jsonClone(t, layout)) {
		t.Fatalf("latest layout = %v", workspace["layout"])
	}
}

func TestWorkspaceRenamesOpensAndConfiguresStartup(t *testing.T) {
	app := newWorkspaceTestApp(t)
	layout := workspaceLayoutFixture()
	pane := layoutPane(t, layout, 0)
	pane["tabs"] = append(pane["tabs"].([]any), map[string]any{
		"id":             "terminal-2",
		"kind":           "terminal",
		"title":          "Staging",
		"profile":        map[string]any{"kind": "ssh", "target": "staging"},
		"offerReconnect": true,
	})

	save := request(t, app, http.MethodPut, "/api/workspaces", map[string]any{
		"name":   "Daily work",
		"layout": layout,
		"multiExecGroups": []any{
			map[string]any{"id": "routers", "name": "Routers", "tabIds": []any{"terminal-1", "terminal-2"}},
		},
	}, true)
	if save.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", save.Code, save.Body.String())
	}
	id := decodeBody(t, save)["id"].(string)

	rename := request(t, app, http.MethodPatch, "/api/workspaces/"+id,
		map[string]any{"name": "Operations"}, true)
	if rename.Code != http.StatusOK {
		t.Fatalf("rename status = %d, body = %s", rename.Code, rename.Body.String())
	}
	renamed := decodeBody(t, rename)
	if renamed["name"] != "Operations" {
		t.Fatalf("renamed name = %v", renamed["name"])
	}
	groups, ok := renamed["multiExecGroups"].([]any)
	if !ok || len(groups) != 1 {
		t.Fatalf("multiExecGroups = %v", renamed["multiExecGroups"])
	}
	group := groups[0].(map[string]any)
	if group["id"] != "routers" || group["name"] != "Routers" {
		t.Fatalf("group = %v", group)
	}

	startup := request(t, app, http.MethodPut, "/api/workspaces/startup",
		map[string]any{"id": id}, true)
	if startup.Code != http.StatusOK {
		t.Fatalf("startup status = %d, body = %s", startup.Code, startup.Body.String())
	}
	startupWorkspace := decodeBody(t, startup)["workspace"].(map[string]any)
	if startupWorkspace["id"] != id || startupWorkspace["isStartup"] != true {
		t.Fatalf("startup workspace = %v", startupWorkspace)
	}

	open := request(t, app, http.MethodPost, "/api/workspaces/"+id+"/open", nil, true)
	if open.Code != http.StatusOK {
		t.Fatalf("open status = %d", open.Code)
	}
	if lastOpenedAt, _ := decodeBody(t, open)["lastOpenedAt"].(string); lastOpenedAt == "" {
		t.Fatalf("lastOpenedAt missing: %s", open.Body.String())
	}

	readStartup := request(t, app, http.MethodGet, "/api/workspaces/startup", nil, true)
	workspace := decodeBody(t, readStartup)["workspace"].(map[string]any)
	if workspace["id"] != id || workspace["name"] != "Operations" {
		t.Fatalf("startup read = %v", workspace)
	}
}

func TestWorkspaceDeleteClearsStartupSelection(t *testing.T) {
	app := newWorkspaceTestApp(t)
	save := request(t, app, http.MethodPut, "/api/workspaces",
		map[string]any{"name": "Temporary", "layout": workspaceLayoutFixture()}, true)
	id := decodeBody(t, save)["id"].(string)
	request(t, app, http.MethodPut, "/api/workspaces/startup", map[string]any{"id": id}, true)

	deleted := request(t, app, http.MethodDelete, "/api/workspaces/"+id, nil, true)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status = %d", deleted.Code)
	}
	if !reflect.DeepEqual(decodeBody(t, deleted), map[string]any{"deleted": true}) {
		t.Fatalf("delete body = %s", deleted.Body.String())
	}

	read := request(t, app, http.MethodGet, "/api/workspaces/"+id, nil, true)
	if read.Code != http.StatusNotFound {
		t.Fatalf("read status = %d, want 404", read.Code)
	}

	startup := request(t, app, http.MethodGet, "/api/workspaces/startup", nil, true)
	if !reflect.DeepEqual(decodeBody(t, startup), map[string]any{"workspace": nil}) {
		t.Fatalf("startup body = %s", startup.Body.String())
	}
}

func TestWorkspaceLatestIsNullWhenEmpty(t *testing.T) {
	app := newWorkspaceTestApp(t)
	rec := request(t, app, http.MethodGet, "/api/workspaces/latest", nil, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !reflect.DeepEqual(decodeBody(t, rec), map[string]any{"workspace": nil}) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestWorkspaceRejectsInvalidSplitDimensions(t *testing.T) {
	app := newWorkspaceTestApp(t)
	layout := workspaceLayoutFixture()
	layout["root"].(map[string]any)["ratio"] = 0.99

	rec := request(t, app, http.MethodPut, "/api/workspaces",
		map[string]any{"name": "Broken", "layout": layout}, true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestWorkspaceRejectsDanglingMultiExecReferences(t *testing.T) {
	app := newWorkspaceTestApp(t)
	rec := request(t, app, http.MethodPut, "/api/workspaces", map[string]any{
		"name":   "Broken group",
		"layout": workspaceLayoutFixture(),
		"multiExecGroups": []any{
			map[string]any{"id": "routers", "name": "Routers", "tabIds": []any{"terminal-1", "missing"}},
		},
	}, true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	message, _ := decodeBody(t, rec)["message"].(string)
	if !regexp.MustCompile(`unknown terminal tab`).MatchString(message) {
		t.Fatalf("message = %q", message)
	}
}

func TestWorkspaceRejectsAmbiguousOrDanglingIdentifiers(t *testing.T) {
	app := newWorkspaceTestApp(t)

	duplicate := workspaceLayoutFixture()
	layoutPane(t, duplicate, 1)["id"] = layoutPane(t, duplicate, 0)["id"]
	duplicateRec := request(t, app, http.MethodPut, "/api/workspaces",
		map[string]any{"name": "Duplicate panes", "layout": duplicate}, true)
	if duplicateRec.Code != http.StatusBadRequest {
		t.Fatalf("duplicate status = %d, want 400", duplicateRec.Code)
	}
	message, _ := decodeBody(t, duplicateRec)["message"].(string)
	if !regexp.MustCompile(`duplicate workspace node id`).MatchString(message) {
		t.Fatalf("duplicate message = %q", message)
	}

	dangling := workspaceLayoutFixture()
	dangling["activePaneId"] = "missing-pane"
	danglingRec := request(t, app, http.MethodPut, "/api/workspaces",
		map[string]any{"name": "Dangling focus", "layout": dangling}, true)
	if danglingRec.Code != http.StatusBadRequest {
		t.Fatalf("dangling status = %d, want 400", danglingRec.Code)
	}
	message, _ = decodeBody(t, danglingRec)["message"].(string)
	if !regexp.MustCompile(`active pane.*does not exist`).MatchString(message) {
		t.Fatalf("dangling message = %q", message)
	}
}
