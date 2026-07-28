// Package routes registers the REST surface, one file per route group,
// mirroring server/src/routes/.
package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/localpty"
	"github.com/FloSch62/muxus/app/internal/semver"
	"github.com/FloSch62/muxus/app/internal/server"
	"github.com/FloSch62/muxus/app/internal/version"
)

const (
	updateCheckTimeout   = 10 * time.Second
	updateReleasePathPre = "/FloSch62/muxus/releases/"
)

// updateManifestURL is a var so tests can point the checker at a local
// manifest server.
var updateManifestURL = "https://flosch62.github.io/muxus/latest.json"

// NodePlatform maps GOOS onto Node's process.platform names the client
// switches on.
func NodePlatform() string {
	switch runtime.GOOS {
	case "windows":
		return "win32"
	default:
		return runtime.GOOS
	}
}

func appInfo() api.AppInfo {
	home, _ := os.UserHomeDir()
	return api.AppInfo{
		Name:         "Muxus",
		Version:      version.Get(),
		Platform:     NodePlatform(),
		HomeDir:      home,
		DefaultShell: localpty.DefaultShell(),
	}
}

// releaseURL validates the manifest's release link against the hardcoded
// allowlist: only HTTPS github.com links inside this repo's releases.
func releaseURL(value string) string {
	u, err := url.Parse(value)
	if err != nil {
		return ""
	}
	if u.Scheme != "https" || u.Hostname() != "github.com" {
		return ""
	}
	if len(u.Path) < len(updateReleasePathPre) || u.Path[:len(updateReleasePathPre)] != updateReleasePathPre {
		return ""
	}
	return u.String()
}

type updateManifest struct {
	Version     any `json:"version"`
	ReleaseName any `json:"releaseName"`
	ReleaseURL  any `json:"releaseUrl"`
	PublishedAt any `json:"publishedAt"`
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func checkForUpdate(force bool) api.UpdateCheckResult {
	currentVersion := version.Get()
	result := api.UpdateCheckResult{Available: false, CurrentVersion: currentVersion}

	target, _ := url.Parse(updateManifestURL)
	if force {
		q := target.Query()
		q.Set("t", strconv.FormatInt(time.Now().UnixMilli(), 10))
		target.RawQuery = q.Encode()
	}
	req, err := http.NewRequest(http.MethodGet, target.String(), nil)
	if err != nil {
		result.Reason = "network"
		return result
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Muxus/"+currentVersion)

	client := &http.Client{Timeout: updateCheckTimeout}
	resp, err := client.Do(req)
	if err != nil {
		if urlErr, ok := err.(*url.Error); ok && urlErr.Timeout() {
			result.Reason = "timeout"
		} else {
			result.Reason = "network"
		}
		return result
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		result.Reason = "no-release"
		return result
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		result.Reason = "manifest-" + strconv.Itoa(resp.StatusCode)
		return result
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		result.Reason = "network"
		return result
	}
	var manifest updateManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		result.Reason = "network"
		return result
	}
	rawVersion := asString(manifest.Version)
	if rawVersion == "" {
		result.Reason = "missing-version"
		return result
	}
	latestVersion := normalizeVersion(rawVersion)
	result.LatestVersion = latestVersion
	if !semver.IsNewerVersion(latestVersion, currentVersion) {
		return result
	}
	downloadURL := releaseURL(asString(manifest.ReleaseURL))
	if downloadURL == "" {
		result.Reason = "missing-release-url"
		return result
	}
	return api.UpdateCheckResult{
		Available:      true,
		CurrentVersion: currentVersion,
		LatestVersion:  latestVersion,
		ReleaseName:    asString(manifest.ReleaseName),
		ReleaseURL:     downloadURL,
		PublishedAt:    asString(manifest.PublishedAt),
	}
}

func normalizeVersion(v string) string {
	trimmed := strings.TrimSpace(v)
	if len(trimmed) > 0 && (trimmed[0] == 'v' || trimmed[0] == 'V') {
		return trimmed[1:]
	}
	return trimmed
}

// updateCache memoizes the check like the Node module-level promise: the
// first result is reused until a force refresh replaces it.
type updateCache struct {
	mu      sync.Mutex
	result  *api.UpdateCheckResult
	pending chan struct{}
}

func (c *updateCache) get(force bool) api.UpdateCheckResult {
	for {
		c.mu.Lock()
		if c.result != nil && !force {
			r := *c.result
			c.mu.Unlock()
			return r
		}
		if c.pending != nil {
			pending := c.pending
			c.mu.Unlock()
			<-pending
			if force {
				// The finished run may predate the force request; loop and
				// start a fresh one.
				force = false
			}
			continue
		}
		pending := make(chan struct{})
		c.pending = pending
		c.mu.Unlock()

		result := checkForUpdate(force)

		c.mu.Lock()
		c.result = &result
		c.pending = nil
		close(pending)
		c.mu.Unlock()
		return result
	}
}

// RegisterAppRoutes mirrors registerAppRoutes.
func RegisterAppRoutes(r chi.Router, _ *server.Context) {
	cache := &updateCache{}
	r.Get("/api/app/info", func(w http.ResponseWriter, _ *http.Request) {
		server.WriteJSON(w, http.StatusOK, appInfo())
	})
	r.Get("/api/app/update-check", func(w http.ResponseWriter, req *http.Request) {
		force := req.URL.Query().Get("force") == "true"
		server.WriteJSON(w, http.StatusOK, cache.get(force))
	})
}
