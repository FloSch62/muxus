package persist_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/FloSch62/muxus/app/internal/persist"
	_ "modernc.org/sqlite"
)

// Ported from the database-level assertions of
// tests/unit/server/session-history-migration.test.ts: version-6 history
// rows are detected, and finalization removes every history table.
func TestLegacySessionHistoryDetectionAndSeparation(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "muxus.sqlite")

	initial, err := persist.Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if legacy := must(initial.HasLegacySessionHistory()); legacy {
		t.Fatal("fresh database reports legacy history")
	}
	if err := initial.Close(); err != nil {
		t.Fatal(err)
	}

	legacy, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`
      INSERT INTO session_logs(
        id, profile_key, title, kind, host, started_at, ended_at,
        status, capture_input, event_count, raw_bytes, normalized_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
		"legacy-session", "ssh:legacy", "Legacy router", "ssh", "legacy",
		"2026-01-01T10:00:00.000Z", "2026-01-01T10:01:00.000Z",
		"completed", 0, 1, 13, 13,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`
      INSERT INTO session_log_events(
        session_id, part_number, sequence, recorded_at, elapsed_ms,
        direction, raw_data, normalized_text
      ) VALUES (?, 1, 1, ?, 1000, 'output', ?, ?)
    `,
		"legacy-session", "2026-01-01T10:00:01.000Z",
		[]byte("legacy output"), "legacy output",
	); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := persist.Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if hasLegacy := must(db.HasLegacySessionHistory()); !hasLegacy {
		t.Fatal("legacy history not detected")
	}
	if err := db.FinalizeSessionHistorySeparation(true); err != nil {
		t.Fatal(err)
	}
	if hasLegacy := must(db.HasLegacySessionHistory()); hasLegacy {
		t.Fatal("legacy history still reported after separation")
	}

	compacted, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer compacted.Close()
	rows, err := compacted.Query(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('session_logs', 'session_log_events', 'session_log_events_fts')
    `)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var remaining []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		remaining = append(remaining, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 0 {
		t.Fatalf("history tables survived: %v", remaining)
	}
}
