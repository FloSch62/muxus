package routes

import (
	"net/http"
	"reflect"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/persist"
)

func newProfileTestApp(t *testing.T) http.Handler {
	t.Helper()
	return newDBTestApp(t, func(r chi.Router, db *persist.DB) {
		RegisterProfileRoutes(r, db)
	})
}

// Ported from tests/unit/server/profile-routes.test.ts.
func TestProfileRoutesManageTelnetAndSerialHosts(t *testing.T) {
	app := newProfileTestApp(t)

	create := request(t, app, http.MethodPut, "/api/profiles", map[string]any{
		"name": "Console server",
		"profile": map[string]any{
			"kind": "telnet",
			"host": "console.example.test",
			"port": 2323,
		},
	}, true)
	if create.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}
	created := decodeBody(t, create)
	if created["kind"] != "telnet" || created["name"] != "Console server" {
		t.Fatalf("created = %v", created)
	}
	createdProfile, ok := created["profile"].(map[string]any)
	if !ok {
		t.Fatalf("created profile = %v", created["profile"])
	}
	if createdProfile["kind"] != "telnet" || createdProfile["host"] != "console.example.test" ||
		createdProfile["port"] != float64(2323) {
		t.Fatalf("created profile = %v", createdProfile)
	}
	id := created["id"].(string)
	if createdProfile["profileId"] != id {
		t.Fatalf("profileId = %v, want %v", createdProfile["profileId"], id)
	}

	organize := request(t, app, http.MethodPatch, "/api/profiles/"+id+"/metadata", map[string]any{
		"group": "Network lab",
		"color": "#22c55e",
	}, true)
	if organize.Code != http.StatusOK {
		t.Fatalf("organize status = %d, body = %s", organize.Code, organize.Body.String())
	}
	organized := decodeBody(t, organize)
	if organized["id"] != id {
		t.Fatalf("organized id = %v", organized["id"])
	}
	organizedMetadata := organized["metadata"].(map[string]any)
	if organizedMetadata["group"] != "Network lab" || organizedMetadata["color"] != "#22c55e" {
		t.Fatalf("organized metadata = %v", organizedMetadata)
	}

	highlights := map[string]any{
		"inheritGlobal": false,
		"rules": []any{
			map[string]any{
				"id":            "rule-1",
				"keyword":       "ERROR",
				"foreground":    "#ff0000",
				"caseSensitive": true,
				"wholeWord":     true,
			},
		},
	}
	highlighted := request(t, app, http.MethodPatch, "/api/profiles/"+id+"/metadata",
		map[string]any{"keywordHighlights": highlights}, true)
	if highlighted.Code != http.StatusOK {
		t.Fatalf("highlight status = %d, body = %s", highlighted.Code, highlighted.Body.String())
	}
	highlightedMetadata := decodeBody(t, highlighted)["metadata"].(map[string]any)
	if !reflect.DeepEqual(highlightedMetadata["keywordHighlights"], jsonClone(t, highlights)) {
		t.Fatalf("keywordHighlights = %v, want %v", highlightedMetadata["keywordHighlights"], highlights)
	}

	cleared := request(t, app, http.MethodPatch, "/api/profiles/"+id+"/metadata",
		map[string]any{"keywordHighlights": nil}, true)
	if cleared.Code != http.StatusOK {
		t.Fatalf("clear status = %d, body = %s", cleared.Code, cleared.Body.String())
	}
	clearedMetadata := decodeBody(t, cleared)["metadata"].(map[string]any)
	if _, present := clearedMetadata["keywordHighlights"]; present {
		t.Fatalf("keywordHighlights must be absent: %v", clearedMetadata)
	}

	update := request(t, app, http.MethodPut, "/api/profiles", map[string]any{
		"id":   id,
		"name": "USB console",
		"profile": map[string]any{
			"kind":        "serial",
			"path":        "COM3",
			"baudRate":    9600,
			"dataBits":    8,
			"stopBits":    1,
			"parity":      "none",
			"flowControl": "none",
		},
	}, true)
	if update.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", update.Code, update.Body.String())
	}
	updated := decodeBody(t, update)
	if updated["id"] != id || updated["kind"] != "serial" || updated["name"] != "USB console" {
		t.Fatalf("updated = %v", updated)
	}
	updatedProfile := updated["profile"].(map[string]any)
	if updatedProfile["kind"] != "serial" || updatedProfile["path"] != "COM3" ||
		updatedProfile["baudRate"] != float64(9600) {
		t.Fatalf("updated profile = %v", updatedProfile)
	}
	if updated["metadata"].(map[string]any)["group"] != "Network lab" {
		t.Fatalf("updated metadata = %v", updated["metadata"])
	}

	list := request(t, app, http.MethodGet, "/api/profiles", nil, true)
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d", list.Code)
	}
	if !reflect.DeepEqual(decodeBody(t, list)["profiles"], []any{jsonClone(t, updated)}) {
		t.Fatalf("profiles = %s, want [%s]", list.Body.String(), update.Body.String())
	}

	remove := request(t, app, http.MethodDelete, "/api/profiles/"+id, nil, true)
	if remove.Code != http.StatusOK {
		t.Fatalf("remove status = %d", remove.Code)
	}
	if !reflect.DeepEqual(decodeBody(t, remove), map[string]any{"deleted": true}) {
		t.Fatalf("remove body = %s", remove.Body.String())
	}
}

func TestProfileRoutesRejectUnauthenticatedAndInvalid(t *testing.T) {
	app := newProfileTestApp(t)

	unauthenticated := request(t, app, http.MethodGet, "/api/profiles", nil, false)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", unauthenticated.Code)
	}

	invalid := request(t, app, http.MethodPut, "/api/profiles", map[string]any{
		"name": "Broken serial host",
		"profile": map[string]any{
			"kind":     "serial",
			"path":     "",
			"baudRate": 0,
		},
	}, true)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid status = %d, want 400", invalid.Code)
	}
}
