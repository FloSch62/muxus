package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/forwards"
	"github.com/FloSch62/muxus/app/internal/history"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/sshx"
)

// contentSecurityPolicy mirrors server/src/app.ts CONTENT_SECURITY_POLICY.
var contentSecurityPolicy = strings.Join([]string{
	"default-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"img-src 'self' data: blob:",
	"connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
}, "; ")

// dragDownloadPath matches the one endpoint exempt from bearer auth: native
// HTML file drags cannot attach an Authorization header, so it uses a
// short-lived, path-bound ticket issued in an authenticated listing response.
var dragDownloadPath = regexp.MustCompile(`^/api/sftp/[^/]+/drag-download$`)

// Context carries the app-wide singletons, mirroring AppContext.
type Context struct {
	Config      Config
	Log         *slog.Logger
	Connections *sshx.ConnectionManager
	Forwards    *forwards.Manager
	Database    *persist.DB
	History     *history.Store
}

// WriteJSON writes v with the given status; the error body shape is
// api.ErrorBody everywhere.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy",
			"camera=(), geolocation=(), microphone=(), clipboard-read=(self), clipboard-write=(self)")
		next.ServeHTTP(w, r)
	})
}

func bearerAuth(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			if r.Method == http.MethodGet && dragDownloadPath.MatchString(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			if r.Header.Get("Authorization") != "Bearer "+token {
				WriteJSON(w, http.StatusUnauthorized, api.ErrorBody{Message: "unauthorized"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// spaHandler serves the built client with an index.html fallback for
// non-API/WS paths (same-origin SPA routing).
func spaHandler(staticRoot string) http.Handler {
	fileServer := http.FileServer(http.Dir(staticRoot))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/ws/") {
			WriteJSON(w, http.StatusNotFound, api.ErrorBody{Message: "not found"})
			return
		}
		requested := filepath.Join(staticRoot, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
		if info, err := os.Stat(requested); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(staticRoot, "index.html"))
	})
}

func spaFSHandler(staticFS fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(staticFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/ws/") {
			WriteJSON(w, http.StatusNotFound, api.ErrorBody{Message: "not found"})
			return
		}
		requested := strings.TrimPrefix(r.URL.Path, "/")
		if requested != "" {
			if info, err := fs.Stat(staticFS, requested); err == nil && !info.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
			if content, err := fs.ReadFile(staticFS, requested+".gz"); err == nil {
				if contentType := mime.TypeByExtension(filepath.Ext(requested)); contentType != "" {
					w.Header().Set("Content-Type", contentType)
				}
				w.Header().Set("Vary", "Accept-Encoding")
				if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
					w.Header().Set("Content-Encoding", "gzip")
					_, _ = w.Write(content)
					return
				}
				reader, openErr := gzip.NewReader(bytes.NewReader(content))
				if openErr != nil {
					WriteJSON(w, http.StatusInternalServerError, api.ErrorBody{Message: "could not read embedded asset"})
					return
				}
				defer reader.Close()
				_, _ = io.Copy(w, reader)
				return
			}
		}
		content, err := fs.ReadFile(staticFS, "index.html")
		if err != nil {
			WriteJSON(w, http.StatusNotFound, api.ErrorBody{Message: "not found"})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(content)
	})
}

// NewRouter assembles the HTTP surface, mirroring buildApp's hook and route
// registration order.
func NewRouter(ctx *Context, registerRoutes func(r chi.Router)) http.Handler {
	r := chi.NewRouter()
	r.Use(securityHeaders)
	r.Use(bearerAuth(ctx.Config.Token))
	registerRoutes(r)

	staticRoot := ctx.Config.StaticRoot
	if staticRoot == "" {
		staticRoot = defaultStaticRoot()
	}
	if staticRoot != "" {
		if _, err := os.Stat(filepath.Join(staticRoot, "index.html")); err == nil {
			r.NotFound(spaHandler(staticRoot).ServeHTTP)
			return r
		}
	}
	if ctx.Config.StaticFS != nil {
		if _, err := fs.Stat(ctx.Config.StaticFS, "index.html"); err == nil {
			r.NotFound(spaFSHandler(ctx.Config.StaticFS).ServeHTTP)
			return r
		}
	}
	r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusNotFound, api.ErrorBody{Message: "not found"})
	})
	return r
}
