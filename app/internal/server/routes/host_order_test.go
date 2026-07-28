package routes

import (
	"net/http"
	"reflect"
	"regexp"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/persist"
)

// newHostOrderTestApp also registers the profile routes: the suite creates a
// saved host and then orders it, like the vitest suite does over buildApp.
func newHostOrderTestApp(t *testing.T) http.Handler {
	t.Helper()
	return newDBTestApp(t, func(r chi.Router, db *persist.DB) {
		RegisterProfileRoutes(r, db)
		RegisterHostOrderRoutes(r, db)
	})
}

// Ported from tests/unit/server/host-order-routes.test.ts.
func TestHostOrderPersistsAcrossHostSources(t *testing.T) {
	app := newHostOrderTestApp(t)

	create := request(t, app, http.MethodPut, "/api/profiles", map[string]any{
		"name":    "Core router",
		"profile": map[string]any{"kind": "telnet", "host": "router.example.test", "port": 23},
	}, true)
	if create.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}
	profileID := decodeBody(t, create)["id"].(string)

	order := request(t, app, http.MethodPut, "/api/hosts/order", map[string]any{
		"hosts": []any{
			map[string]any{"kind": "profile", "id": profileID},
			map[string]any{"kind": "ssh", "alias": "web-prod"},
		},
	}, true)
	if order.Code != http.StatusOK {
		t.Fatalf("order status = %d, body = %s", order.Code, order.Body.String())
	}
	if !reflect.DeepEqual(decodeBody(t, order), map[string]any{"ok": true}) {
		t.Fatalf("order body = %s", order.Body.String())
	}

	list := request(t, app, http.MethodGet, "/api/profiles", nil, true)
	profiles := decodeBody(t, list)["profiles"].([]any)
	metadata := profiles[0].(map[string]any)["metadata"].(map[string]any)
	if metadata["sortOrder"] != float64(0) {
		t.Fatalf("sortOrder = %v, want 0", metadata["sortOrder"])
	}
}

func TestHostOrderRejectsDuplicatesUnknownProfilesAndUnauthenticated(t *testing.T) {
	app := newHostOrderTestApp(t)

	duplicate := request(t, app, http.MethodPut, "/api/hosts/order", map[string]any{
		"hosts": []any{
			map[string]any{"kind": "ssh", "alias": "same"},
			map[string]any{"kind": "ssh", "alias": "same"},
		},
	}, true)
	if duplicate.Code != http.StatusBadRequest {
		t.Fatalf("duplicate status = %d, want 400", duplicate.Code)
	}
	message, _ := decodeBody(t, duplicate)["message"].(string)
	if !regexp.MustCompile(`duplicate`).MatchString(message) {
		t.Fatalf("duplicate message = %q", message)
	}

	missing := request(t, app, http.MethodPut, "/api/hosts/order", map[string]any{
		"hosts": []any{map[string]any{"kind": "profile", "id": "missing"}},
	}, true)
	if missing.Code != http.StatusInternalServerError {
		t.Fatalf("missing status = %d, want 500", missing.Code)
	}
	message, _ = decodeBody(t, missing)["message"].(string)
	if !regexp.MustCompile(`not found`).MatchString(message) {
		t.Fatalf("missing message = %q", message)
	}

	unauthenticated := request(t, app, http.MethodPut, "/api/hosts/order",
		map[string]any{"hosts": []any{}}, false)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", unauthenticated.Code)
	}
}
