package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The fixtures under tests/contract/fixtures are shared with the vitest suite
// that runs them against the real zod schemas; both sides must agree on every
// verdict, and on the normalized (defaults-applied) form where given.

type fixture struct {
	Name       string          `json:"name"`
	Valid      bool            `json:"valid"`
	Data       json.RawMessage `json:"data"`
	Normalized json.RawMessage `json:"normalized"`
}

func loadFixtures(t *testing.T, file string) []fixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "contract", "fixtures", file))
	if err != nil {
		t.Fatal(err)
	}
	var out []fixture
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func assertNormalized(t *testing.T, got any, want json.RawMessage) {
	t.Helper()
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var gotValue, wantValue any
	if err := json.Unmarshal(gotJSON, &gotValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("normalized form mismatch:\n got %s\nwant %s", gotJSON, want)
	}
}

func TestSessionProfileFixtures(t *testing.T) {
	for _, fx := range loadFixtures(t, "session-profiles.json") {
		t.Run(fx.Name, func(t *testing.T) {
			profile, err := ParseSessionProfile(fx.Data)
			if (err == nil) != fx.Valid {
				t.Fatalf("valid = %v, want %v (err: %v)", err == nil, fx.Valid, err)
			}
			if err == nil && fx.Normalized != nil {
				assertNormalized(t, profile, fx.Normalized)
			}
		})
	}
}

func TestTerminalClientMessageFixtures(t *testing.T) {
	for _, fx := range loadFixtures(t, "terminal-client-messages.json") {
		t.Run(fx.Name, func(t *testing.T) {
			_, err := ParseTerminalClientMessage(fx.Data)
			if (err == nil) != fx.Valid {
				t.Fatalf("valid = %v, want %v (err: %v)", err == nil, fx.Valid, err)
			}
		})
	}
}
