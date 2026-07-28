package history

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FloSch62/muxus/app/internal/api"
)

var testSettings = api.SessionHistorySettings{
	MaxTotalBytes:  5 * 1024 * 1024 * 1024,
	MinFreeBytes:   0,
	MinFreePercent: 0,
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(Options{Root: t.TempDir(), Settings: testSettings})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	return store
}

func TestStoreRotatesRawSegmentsAndSearchesTranscript(t *testing.T) {
	store := openTestStore(t)
	policy := PartPolicy{MaxPartBytes: 64 * 1024, MaxParts: 2}
	id := store.BeginSession(SessionLogCreateInput{
		ProfileKey: "ssh:edge",
		Title:      "Edge router",
		Kind:       "ssh",
		Host:       "edge",
		StartedAt:  "2026-07-24T10:00:00Z",
	}, policy)

	for sequence := int64(1); sequence <= 4; sequence++ {
		text := fmt.Sprintf("event %d\n", sequence)
		if sequence == 3 {
			text = "BGP neighbor established\n"
		}
		if ok := store.Append(id, []HistoryEvent{{
			Sequence:   sequence,
			RecordedAt: "2026-07-24T10:00:01Z",
			ElapsedMs:  sequence * 1000,
			Direction:  "output",
			Raw:        bytes.Repeat([]byte{byte(sequence)}, 40*1024),
			Text:       text,
		}}, policy); !ok {
			t.Fatal("append unexpectedly rejected")
		}
	}
	store.FinishSession(id, "completed", "2026-07-24T10:01:00Z")

	detail, err := store.SessionLog(id, nil)
	if err != nil {
		t.Fatal(err)
	}
	if detail == nil || detail.Status != "completed" || detail.EventCount != 2 ||
		detail.PartCount != 2 || len(detail.Events) != 2 {
		t.Fatalf("detail = %+v", detail)
	}
	if detail.Events[0].Sequence != 3 || detail.Events[1].Sequence != 4 {
		t.Fatalf("retained sequences = %+v", detail.Events)
	}
	raw, err := store.RawSessionLogEvents(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 2 || raw[0].Sequence != 3 || raw[1].Sequence != 4 {
		t.Fatalf("raw retained events = %+v", raw)
	}
	found, err := store.SessionHistory(Query{Query: "BGP established", Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(found.Sessions) != 1 || found.Sessions[0].ID != id {
		t.Fatalf("search result = %+v", found)
	}
	evicted, err := store.SessionHistory(Query{Query: "event 1", Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(evicted.Sessions) != 0 {
		t.Fatalf("evicted text remained searchable: %+v", evicted)
	}

	files, err := os.ReadDir(filepath.Join(store.Root(), "sessions", id))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("segment count = %d", len(files))
	}
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".muxlog.zst") {
			t.Fatalf("unexpected segment %q", file.Name())
		}
	}
}

func TestStoreCursorAndPinnedAgeRetention(t *testing.T) {
	store := openTestStore(t)
	policy := PartPolicy{MaxPartBytes: 1024 * 1024, MaxParts: 2}
	var ids []string
	for day := 1; day <= 3; day++ {
		stamp := fmt.Sprintf("2020-01-%02dT10:00:00Z", day)
		id := store.BeginSession(SessionLogCreateInput{
			ProfileKey: "ssh:edge", Title: fmt.Sprintf("Day %d", day),
			Kind: "ssh", Host: "edge", StartedAt: stamp,
		}, policy)
		if !store.Append(id, []HistoryEvent{{
			Sequence: 1, RecordedAt: stamp, ElapsedMs: 1000,
			Direction: "output", Raw: []byte(stamp), Text: stamp + "\n",
		}}, policy) {
			t.Fatal("append unexpectedly rejected")
		}
		store.FinishSession(id, "completed", stamp)
		ids = append(ids, id)
	}

	first, err := store.SessionHistory(Query{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Sessions) != 2 || first.Sessions[0].Title != "Day 3" ||
		first.Sessions[1].Title != "Day 2" || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}
	second, err := store.SessionHistory(Query{Limit: 2, Cursor: first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Sessions) != 1 || second.Sessions[0].Title != "Day 1" {
		t.Fatalf("second page = %+v", second)
	}
	if updated, err := store.SetPinned(ids[0], true); err != nil || !updated {
		t.Fatalf("pin: updated=%v err=%v", updated, err)
	}
	oneDay := 1
	settings := testSettings
	settings.MaxAgeDays = &oneDay
	if err := store.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	remaining, err := store.SessionHistory(Query{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining.Sessions) != 1 || remaining.Sessions[0].ID != ids[0] ||
		!remaining.Sessions[0].Pinned {
		t.Fatalf("remaining sessions = %+v", remaining)
	}
}
