package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
)

func compressed(t *testing.T, content string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func embeddedTestRouter(t *testing.T) http.Handler {
	t.Helper()
	assets := fstest.MapFS{
		"index.html":       &fstest.MapFile{Data: []byte("<main>Muxus</main>")},
		"assets/app.js.gz": &fstest.MapFile{Data: compressed(t, "window.MUXUS = true;")},
	}
	cfg := ResolveConfig(Overrides{DevToken: "test", StaticRoot: "/does/not/exist"})
	cfg.StaticFS = fs.FS(assets)
	return NewRouter(&Context{Config: cfg}, func(chi.Router) {})
}

func TestEmbeddedAssetsUsePrecompressedPayload(t *testing.T) {
	app := embeddedTestRouter(t)
	request := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	request.Header.Set("Accept-Encoding", "br, gzip")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q", got)
	}
	if got := response.Header().Get("Content-Type"); got != "text/javascript; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "window.MUXUS = true;" {
		t.Fatalf("content = %q", content)
	}
}

func TestEmbeddedAssetsDecompressForLegacyHTTPClients(t *testing.T) {
	app := embeddedTestRouter(t)
	request := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q", got)
	}
	if got := response.Body.String(); got != "window.MUXUS = true;" {
		t.Fatalf("content = %q", got)
	}
}

func TestEmbeddedSPAUsesIndexFallback(t *testing.T) {
	app := embeddedTestRouter(t)
	response := httptest.NewRecorder()
	app.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/workspace/one", nil))

	if response.Code != http.StatusOK || response.Body.String() != "<main>Muxus</main>" {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
}
