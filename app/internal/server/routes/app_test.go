package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/server"
	"github.com/FloSch62/muxus/app/internal/version"
)

const testToken = "app-route-test-token"

func newTestApp(t *testing.T) http.Handler {
	t.Helper()
	prev := version.Version
	version.Version = "0.2.0"
	t.Cleanup(func() { version.Version = prev })

	cfg := server.ResolveConfig(server.Overrides{
		DevToken:   testToken,
		StaticRoot: "/path/that/does/not/exist",
	})
	ctx := &server.Context{Config: cfg}
	return server.NewRouter(ctx, func(r chi.Router) {
		RegisterAppRoutes(r, ctx)
	})
}

func get(t *testing.T, app http.Handler, url string, authed bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, url, nil)
	if authed {
		req.Header.Set("Authorization", "Bearer "+testToken)
	}
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	return rec
}

// Ported from tests/unit/server/app-routes.test.ts.
func TestUpdateCheckReportsNewerTrustedRelease(t *testing.T) {
	var manifestRequest *http.Request
	manifest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		manifestRequest = r.Clone(r.Context())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version": "v0.3.0",
			"releaseName": "Muxus 0.3",
			"releaseUrl": "https://github.com/FloSch62/muxus/releases/tag/v0.3.0",
			"publishedAt": "2026-07-26T08:00:00Z"
		}`))
	}))
	defer manifest.Close()
	prev := updateManifestURL
	updateManifestURL = manifest.URL + "/latest.json"
	defer func() { updateManifestURL = prev }()

	app := newTestApp(t)
	rec := get(t, app, "/api/app/update-check?force=true", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got api.UpdateCheckResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := api.UpdateCheckResult{
		Available:      true,
		CurrentVersion: "0.2.0",
		LatestVersion:  "0.3.0",
		ReleaseName:    "Muxus 0.3",
		ReleaseURL:     "https://github.com/FloSch62/muxus/releases/tag/v0.3.0",
		PublishedAt:    "2026-07-26T08:00:00Z",
	}
	if got != want {
		t.Fatalf("update check = %+v, want %+v", got, want)
	}

	if manifestRequest == nil {
		t.Fatal("manifest was never fetched")
	}
	if !regexp.MustCompile(`^/latest\.json\?t=\d+$`).MatchString(manifestRequest.URL.RequestURI()) {
		t.Fatalf("force fetch URI = %q, want cache-busting t param", manifestRequest.URL.RequestURI())
	}
	if accept := manifestRequest.Header.Get("Accept"); accept != "application/json" {
		t.Fatalf("Accept = %q", accept)
	}
	if ua := manifestRequest.Header.Get("User-Agent"); ua != "Muxus/0.2.0" {
		t.Fatalf("User-Agent = %q", ua)
	}
}

func TestUpdateCheckRejectsForeignReleaseURL(t *testing.T) {
	manifest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version": "0.3.0",
			"releaseUrl": "https://attacker.example/FloSch62/muxus/releases/tag/v0.3.0"
		}`))
	}))
	defer manifest.Close()
	prev := updateManifestURL
	updateManifestURL = manifest.URL + "/latest.json"
	defer func() { updateManifestURL = prev }()

	app := newTestApp(t)
	rec := get(t, app, "/api/app/update-check?force=true", true)
	var got api.UpdateCheckResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := api.UpdateCheckResult{
		Available:      false,
		CurrentVersion: "0.2.0",
		LatestVersion:  "0.3.0",
		Reason:         "missing-release-url",
	}
	if got != want {
		t.Fatalf("update check = %+v, want %+v", got, want)
	}
}

// Ported from tests/unit/server/security-headers.test.ts.
func TestSecurityHeadersPermitWasmWithoutUnsafeEval(t *testing.T) {
	app := newTestApp(t)
	rec := get(t, app, "/api/app/info", true)

	policy := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "script-src 'self' 'wasm-unsafe-eval'") {
		t.Fatalf("CSP missing wasm-unsafe-eval script-src: %q", policy)
	}
	if regexp.MustCompile(`(?:^|[\s;])'unsafe-eval'(?:[\s;]|$)`).MatchString(policy) {
		t.Fatalf("CSP must not allow general 'unsafe-eval': %q", policy)
	}
	if got := rec.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("X-Frame-Options = %q", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
}

func TestBearerAuthRejectsMissingToken(t *testing.T) {
	app := newTestApp(t)
	rec := get(t, app, "/api/app/info", false)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var body api.ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Message != "unauthorized" {
		t.Fatalf("message = %q", body.Message)
	}
}
