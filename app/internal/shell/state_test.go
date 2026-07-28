package shell

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestClientStateReadsLegacyFileAndFlushesAtomically(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client-state.json")
	legacy := []byte(`{"prefs":"{\"theme\":\"dark\"}","ignored":42}`)
	if err := os.WriteFile(path, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	state := openClientState(path, nil)
	if got := state.Snapshot(); len(got) != 1 || got["prefs"] != `{"theme":"dark"}` {
		t.Fatalf("snapshot = %#v", got)
	}
	state.Set("tabs", `[{"id":"one"}]`)
	state.Remove("prefs")
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]string
	if err := json.Unmarshal(content, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 || saved["tabs"] != `[{"id":"one"}]` {
		t.Fatalf("saved state = %#v", saved)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temporary file remains: %v", err)
	}
}

func TestWindowStateUsesFallbackAndPreservesNormalBounds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "window-state.json")
	if got := readWindowState(path); got.Width != 1440 || got.Height != 900 {
		t.Fatalf("fallback = %+v", got)
	}
	x, y := 12, 34
	want := windowState{Width: 1280, Height: 720, X: &x, Y: &y, Maximized: true}
	if err := writeJSONAtomic(path, want); err != nil {
		t.Fatal(err)
	}
	got := readWindowState(path)
	if got.Width != want.Width || got.Height != want.Height || got.X == nil ||
		got.Y == nil || *got.X != x || *got.Y != y || !got.Maximized {
		t.Fatalf("round trip = %+v", got)
	}
}
