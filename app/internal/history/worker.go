package history

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
	_ "modernc.org/sqlite"

	"github.com/FloSch62/muxus/app/internal/api"
)

// segmentHeader is the shared muxlog magic: "MUXLOG" 0x01 0x0a. Segments
// written by either implementation must decode in the other.
var segmentHeader = []byte{0x4d, 0x55, 0x58, 0x4c, 0x4f, 0x47, 0x01, 0x0a}

const (
	quotaCheckBytes    = 1024 * 1024
	quotaCheckInterval = 2 * time.Second
	frameFixedBytes    = 25
)

var directionToByte = map[string]byte{"input": 1, "output": 2, "system": 3}
var byteToDirection = map[byte]string{1: "input", 2: "output", 3: "system"}

var safeSessionNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
var partialNamePattern = regexp.MustCompile(`^(\d{6})\.muxlog\.partial$`)

// historyDDL is the schema from history-worker.js, verbatim, so a root
// created by the Node implementation opens unchanged here and vice versa.
const historyDDL = `
  CREATE TABLE IF NOT EXISTS history_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;

  CREATE TABLE IF NOT EXISTS session_logs (
    id TEXT PRIMARY KEY,
    profile_key TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('openssh', 'ssh', 'local', 'serial', 'telnet')),
    host TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'disconnected', 'failed')),
    paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)),
    capture_input INTEGER NOT NULL CHECK(capture_input IN (0, 1)),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK(event_count >= 0),
    raw_bytes INTEGER NOT NULL DEFAULT 0 CHECK(raw_bytes >= 0),
    normalized_bytes INTEGER NOT NULL DEFAULT 0 CHECK(normalized_bytes >= 0),
    current_part INTEGER NOT NULL DEFAULT 1 CHECK(current_part >= 1),
    current_part_bytes INTEGER NOT NULL DEFAULT 0 CHECK(current_part_bytes >= 0)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS session_parts (
    session_id TEXT NOT NULL REFERENCES session_logs(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL CHECK(part_number >= 1),
    filename TEXT NOT NULL,
    raw_bytes INTEGER NOT NULL CHECK(raw_bytes >= 0),
    stored_bytes INTEGER NOT NULL CHECK(stored_bytes >= 0),
    event_count INTEGER NOT NULL CHECK(event_count >= 0),
    normalized_bytes INTEGER NOT NULL CHECK(normalized_bytes >= 0),
    first_sequence INTEGER,
    last_sequence INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(session_id, part_number)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS transcript_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES session_logs(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL CHECK(part_number >= 1),
    first_sequence INTEGER NOT NULL CHECK(first_sequence >= 1),
    last_sequence INTEGER NOT NULL CHECK(last_sequence >= first_sequence),
    recorded_at TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
    direction TEXT NOT NULL CHECK(direction IN ('input', 'output', 'system')),
    normalized_text TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS session_logs_started
    ON session_logs(started_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS session_logs_profile_started
    ON session_logs(profile_key, started_at DESC);
  CREATE INDEX IF NOT EXISTS session_logs_retention
    ON session_logs(pinned, status, started_at);
  CREATE INDEX IF NOT EXISTS transcript_chunks_session_sequence
    ON transcript_chunks(session_id, first_sequence);
  CREATE INDEX IF NOT EXISTS transcript_chunks_session_part
    ON transcript_chunks(session_id, part_number);

  CREATE VIRTUAL TABLE IF NOT EXISTS transcript_chunks_fts USING fts5(
    normalized_text,
    content = 'transcript_chunks',
    content_rowid = 'id',
    tokenize = 'unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS transcript_chunks_fts_insert
  AFTER INSERT ON transcript_chunks BEGIN
    INSERT INTO transcript_chunks_fts(rowid, normalized_text)
    VALUES (new.id, new.normalized_text);
  END;
  CREATE TRIGGER IF NOT EXISTS transcript_chunks_fts_delete
  AFTER DELETE ON transcript_chunks BEGIN
    INSERT INTO transcript_chunks_fts(transcript_chunks_fts, rowid, normalized_text)
    VALUES ('delete', old.id, old.normalized_text);
  END;
  CREATE TRIGGER IF NOT EXISTS transcript_chunks_fts_update
  AFTER UPDATE ON transcript_chunks BEGIN
    INSERT INTO transcript_chunks_fts(transcript_chunks_fts, rowid, normalized_text)
    VALUES ('delete', old.id, old.normalized_text);
    INSERT INTO transcript_chunks_fts(rowid, normalized_text)
    VALUES (new.id, new.normalized_text);
  END;

  INSERT OR IGNORE INTO history_schema_migrations(version, name)
  VALUES (1, 'hybrid-session-history');
`

type segmentWriter struct {
	sessionID       string
	part            int
	policy          PartPolicy
	file            *os.File
	partialPath     string
	rawBytes        int64
	normalizedBytes int64
	eventCount      int64
	firstSequence   *int64
	lastSequence    *int64
}

type worker struct {
	root               string
	settings           api.SessionHistorySettings
	legacyDatabasePath string
	databaseFile       string
	sessionsRoot       string
	trashRoot          string

	db      *sql.DB
	writers map[string]*segmentWriter
	enc     *zstd.Encoder
	dec     *zstd.Decoder

	bytesSinceQuotaCheck int64
	lastQuotaCheck       time.Time
	quotaSuspended       bool
	quotaWarning         string
	closed               bool
}

func newWorker(root string, settings api.SessionHistorySettings, legacyDatabasePath string) *worker {
	return &worker{
		root:               root,
		settings:           settings,
		legacyDatabasePath: legacyDatabasePath,
		databaseFile:       filepath.Join(root, "session-history.sqlite"),
		sessionsRoot:       filepath.Join(root, "sessions"),
		trashRoot:          filepath.Join(root, ".trash"),
		writers:            map[string]*segmentWriter{},
	}
}

func (w *worker) init() error {
	if err := os.MkdirAll(w.sessionsRoot, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(w.trashRoot, 0o700); err != nil {
		return err
	}
	var err error
	if w.enc, err = zstd.NewWriter(nil); err != nil {
		return err
	}
	if w.dec, err = zstd.NewReader(nil, zstd.WithDecoderConcurrency(1)); err != nil {
		return err
	}
	query := url.Values{}
	query.Set("_txlock", "immediate")
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "synchronous(NORMAL)")
	db, err := sql.Open("sqlite", "file:"+w.databaseFile+"?"+query.Encode())
	if err != nil {
		return err
	}
	// One connection: the worker relies on the Node worker's single
	// synchronous handle for explicit transactions and PRAGMAs.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return err
	}
	w.db = db
	// Some filesystems own permission policy.
	_ = os.Chmod(w.databaseFile, 0o600)
	if _, err := db.Exec(historyDDL); err != nil {
		db.Close()
		return err
	}
	if err := w.removeTrash(); err != nil {
		db.Close()
		return err
	}
	if w.legacyDatabasePath != "" && w.legacyDatabasePath != ":memory:" {
		if err := w.importLegacyHistory(w.legacyDatabasePath); err != nil {
			db.Close()
			return err
		}
	}
	if err := w.recoverInterruptedSessions(); err != nil {
		db.Close()
		return err
	}
	if err := w.enforceRetention(true); err != nil {
		db.Close()
		return err
	}
	return nil
}

func (w *worker) maintenance() {
	// A later write/status request will surface persistent storage failures.
	_ = w.enforceRetention(true)
	_, _ = w.db.Exec("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;")
}

func (w *worker) beginSession(id string, input SessionLogCreateInput, policy PartPolicy) error {
	if err := w.enforceRetention(false); err != nil {
		return err
	}
	if w.quotaSuspended {
		return errors.New(w.quotaWarningOrDefault())
	}
	if _, err := w.db.Exec(`
    INSERT INTO session_logs(
      id, profile_key, title, kind, host, started_at, status, capture_input
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `, id, input.ProfileKey, input.Title, input.Kind, input.Host, input.StartedAt,
		boolToInt(input.CaptureInput)); err != nil {
		return err
	}
	_, err := w.openWriter(id, 1, policy)
	return err
}

type retainedEvent struct {
	HistoryEvent
	part int
}

func (w *worker) appendEvents(sessionID string, events []HistoryEvent, policy PartPolicy) (bool, error) {
	if w.quotaSuspended {
		return false, errors.New(w.quotaWarningOrDefault())
	}
	var status string
	var currentPart, currentPartBytes int64
	err := w.db.QueryRow(
		"SELECT status, current_part, current_part_bytes FROM session_logs WHERE id = ?",
		sessionID,
	).Scan(&status, &currentPart, &currentPartBytes)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && status != "active") {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	writer := w.writers[sessionID]
	if writer == nil {
		if writer, err = w.openWriter(sessionID, int(currentPart), policy); err != nil {
			return false, err
		}
	}
	retained := make([]retainedEvent, 0, len(events))
	var rawBytes, normalizedBytes int64
	for _, event := range events {
		frame := encodeFrame(event)
		if writer.eventCount > 0 &&
			writer.rawBytes+int64(len(event.Raw)) > int64(policy.MaxPartBytes) {
			if err := w.finalizeWriter(sessionID); err != nil {
				return false, err
			}
			if writer, err = w.openWriter(sessionID, writer.part+1, policy); err != nil {
				return false, err
			}
			if err := w.trimSessionParts(sessionID, policy.MaxParts); err != nil {
				return false, err
			}
		}
		if _, err := writer.file.Write(frame); err != nil {
			return false, err
		}
		writer.rawBytes += int64(len(event.Raw))
		writer.eventCount++
		if writer.firstSequence == nil {
			sequence := event.Sequence
			writer.firstSequence = &sequence
		}
		sequence := event.Sequence
		writer.lastSequence = &sequence
		rawBytes += int64(len(event.Raw))
		textBytes := int64(len(event.Text))
		writer.normalizedBytes += textBytes
		normalizedBytes += textBytes
		retained = append(retained, retainedEvent{HistoryEvent: event, part: writer.part})
	}
	// One SQLite transaction per recorder batch (normally every 250 ms).
	tx, err := w.db.Begin()
	if err != nil {
		return false, err
	}
	commit := func() error {
		for _, event := range retained {
			if event.Text == "" {
				continue
			}
			if _, err := tx.Exec(`
        INSERT INTO transcript_chunks(
          session_id, part_number, first_sequence, last_sequence,
          recorded_at, elapsed_ms, direction, normalized_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, sessionID, event.part, event.Sequence, event.Sequence,
				event.RecordedAt, event.ElapsedMs, event.Direction, event.Text); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`
      UPDATE session_logs
      SET current_part = ?,
          current_part_bytes = ?,
          event_count = event_count + ?,
          raw_bytes = raw_bytes + ?,
          normalized_bytes = normalized_bytes + ?
      WHERE id = ? AND status = 'active'
    `, writer.part, writer.rawBytes, len(events), rawBytes, normalizedBytes, sessionID); err != nil {
			return err
		}
		return tx.Commit()
	}
	if err := commit(); err != nil {
		_ = tx.Rollback()
		return false, err
	}
	w.bytesSinceQuotaCheck += rawBytes + normalizedBytes
	if w.bytesSinceQuotaCheck >= quotaCheckBytes ||
		time.Since(w.lastQuotaCheck) >= quotaCheckInterval {
		if err := w.enforceRetention(false); err != nil {
			return false, err
		}
	}
	if w.quotaSuspended {
		return false, errors.New(w.quotaWarningOrDefault())
	}
	return true, nil
}

func (w *worker) setSessionState(sessionID string, paused, captureInput *bool) (bool, error) {
	var storedPaused, storedCapture int
	err := w.db.QueryRow(
		"SELECT paused, capture_input FROM session_logs WHERE id = ?", sessionID,
	).Scan(&storedPaused, &storedCapture)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	nextPaused := storedPaused
	if paused != nil {
		nextPaused = boolToInt(*paused)
	}
	nextCapture := storedCapture
	if captureInput != nil {
		nextCapture = boolToInt(*captureInput)
	}
	_, err = w.db.Exec(
		"UPDATE session_logs SET paused = ?, capture_input = ? WHERE id = ?",
		nextPaused, nextCapture, sessionID,
	)
	return err == nil, err
}

func (w *worker) finishSession(sessionID, status, endedAt string) error {
	if err := w.finalizeWriter(sessionID); err != nil {
		return err
	}
	if _, err := w.db.Exec(`
    UPDATE session_logs
    SET status = ?, ended_at = ?, paused = 0, current_part_bytes = 0
    WHERE id = ? AND status = 'active'
  `, status, endedAt, sessionID); err != nil {
		return err
	}
	return w.enforceRetention(true)
}

type logRow struct {
	id, profileKey, title, kind, host, startedAt string
	endedAt                                      sql.NullString
	status                                       string
	paused, captureInput, pinned                 int
	eventCount, rawBytes, normalizedBytes        int64
	currentPart, currentPartBytes                int64
	snippet                                      sql.NullString
	retainedPartCount                            int64
}

func scanLogRow(scan func(dest ...any) error) (*logRow, error) {
	var row logRow
	if err := scan(
		&row.id, &row.profileKey, &row.title, &row.kind, &row.host,
		&row.startedAt, &row.endedAt, &row.status, &row.paused,
		&row.captureInput, &row.pinned, &row.eventCount, &row.rawBytes,
		&row.normalizedBytes, &row.currentPart, &row.currentPartBytes,
		&row.snippet, &row.retainedPartCount,
	); err != nil {
		return nil, err
	}
	return &row, nil
}

func summaryFromRow(row *logRow) api.SessionLogSummary {
	return api.SessionLogSummary{
		ID:              row.id,
		ProfileKey:      row.profileKey,
		Title:           row.title,
		Kind:            row.kind,
		Host:            row.host,
		StartedAt:       row.startedAt,
		EndedAt:         row.endedAt.String,
		Status:          row.status,
		Paused:          row.paused == 1,
		CaptureInput:    row.captureInput == 1,
		Pinned:          row.pinned == 1,
		EventCount:      row.eventCount,
		RawBytes:        row.rawBytes,
		NormalizedBytes: row.normalizedBytes,
		PartCount:       row.retainedPartCount,
		Snippet:         row.snippet.String,
	}
}

func (w *worker) search(input Query) (api.SessionHistoryResponse, error) {
	var zero api.SessionHistoryResponse
	limit := input.Limit
	if limit <= 0 {
		limit = 50
	}
	limit = int(math.Min(100, math.Max(1, float64(limit))))
	args := []any{}
	filters := []string{}
	withSQL := ""
	joinSQL := ""
	selectSnippet := "NULL AS snippet"
	expression := ftsExpression(input.Query)
	if expression != "" {
		withSQL = `
      WITH event_matches AS (
        SELECT chunks.session_id, MIN(chunks.id) AS match_id
        FROM transcript_chunks_fts
        JOIN transcript_chunks AS chunks ON chunks.id = transcript_chunks_fts.rowid
        WHERE transcript_chunks_fts MATCH ?
        GROUP BY chunks.session_id
      )
    `
		args = append(args, expression)
		joinSQL = `
      LEFT JOIN event_matches ON event_matches.session_id = logs.id
      LEFT JOIN transcript_chunks AS matched ON matched.id = event_matches.match_id
    `
		metadata := "%" + escapeLike(strings.TrimSpace(input.Query)) + "%"
		filters = append(filters, `(
      event_matches.session_id IS NOT NULL
      OR logs.title LIKE ? ESCAPE '\' COLLATE NOCASE
      OR logs.host LIKE ? ESCAPE '\' COLLATE NOCASE
    )`)
		args = append(args, metadata, metadata)
		selectSnippet = "substr(matched.normalized_text, 1, 300) AS snippet"
	}
	if input.ProfileKey != "" {
		filters = append(filters, "logs.profile_key = ?")
		args = append(args, input.ProfileKey)
	}
	if input.Host != "" {
		filters = append(filters, `logs.host LIKE ? ESCAPE '\' COLLATE NOCASE`)
		args = append(args, "%"+escapeLike(input.Host)+"%")
	}
	if input.Kind != "" {
		filters = append(filters, "logs.kind = ?")
		args = append(args, input.Kind)
	}
	if input.StartedAfter != "" {
		filters = append(filters, "logs.started_at >= ?")
		args = append(args, input.StartedAfter)
	}
	if input.StartedBefore != "" {
		filters = append(filters, "logs.started_at <= ?")
		args = append(args, input.StartedBefore)
	}
	if cursor := decodeCursor(input.Cursor); cursor != nil {
		filters = append(filters, "(logs.started_at < ? OR (logs.started_at = ? AND logs.id < ?))")
		args = append(args, cursor.startedAt, cursor.startedAt, cursor.id)
	}
	where := ""
	if len(filters) > 0 {
		where = "WHERE " + strings.Join(filters, " AND ")
	}
	args = append(args, limit+1)
	rows, err := w.db.Query(`
    `+withSQL+`
    SELECT logs.*, `+selectSnippet+`, (
      SELECT COUNT(*) FROM session_parts AS parts WHERE parts.session_id = logs.id
    ) AS retained_part_count
    FROM session_logs AS logs
    `+joinSQL+`
    `+where+`
    ORDER BY logs.started_at DESC, logs.id DESC
    LIMIT ?
  `, args...)
	if err != nil {
		return zero, err
	}
	collected := []*logRow{}
	for rows.Next() {
		row, err := scanLogRow(rows.Scan)
		if err != nil {
			rows.Close()
			return zero, err
		}
		collected = append(collected, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return zero, err
	}
	hasMore := len(collected) > limit
	page := collected
	if hasMore {
		page = collected[:limit]
	}
	sessions := make([]api.SessionLogSummary, 0, len(page))
	for _, row := range page {
		sessions = append(sessions, summaryFromRow(row))
	}
	response := api.SessionHistoryResponse{Sessions: sessions}
	if hasMore && len(page) > 0 {
		last := page[len(page)-1]
		response.NextCursor = encodeCursor(last.startedAt, last.id)
	}
	return response, nil
}

func (w *worker) detail(id string, eventLimit *int) (*api.SessionLogDetail, error) {
	row, err := scanLogRow(w.db.QueryRow(`
    SELECT logs.*, NULL AS snippet, (
      SELECT COUNT(*) FROM session_parts AS parts WHERE parts.session_id = logs.id
    ) AS retained_part_count
    FROM session_logs AS logs WHERE logs.id = ?
  `, id).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var totalChunks int64
	if err := w.db.QueryRow(
		"SELECT COUNT(*) AS total FROM transcript_chunks WHERE session_id = ?", id,
	).Scan(&totalChunks); err != nil {
		return nil, err
	}
	query := `
    SELECT first_sequence, recorded_at, elapsed_ms, direction, normalized_text
    FROM transcript_chunks WHERE session_id = ? ORDER BY first_sequence
  `
	queryArgs := []any{id}
	if eventLimit != nil {
		query = `
      SELECT * FROM (
        SELECT first_sequence, recorded_at, elapsed_ms, direction, normalized_text
        FROM transcript_chunks WHERE session_id = ?
        ORDER BY first_sequence DESC LIMIT ?
      ) ORDER BY first_sequence
    `
		queryArgs = append(queryArgs, *eventLimit)
	}
	rows, err := w.db.Query(query, queryArgs...)
	if err != nil {
		return nil, err
	}
	events := []api.SessionLogEvent{}
	for rows.Next() {
		var event api.SessionLogEvent
		if err := rows.Scan(
			&event.Sequence, &event.RecordedAt, &event.ElapsedMs,
			&event.Direction, &event.Text,
		); err != nil {
			rows.Close()
			return nil, err
		}
		events = append(events, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &api.SessionLogDetail{
		SessionLogSummary: summaryFromRow(row),
		Events:            events,
		EventsTruncated:   int64(len(events)) < totalChunks,
	}, nil
}

func (w *worker) rawEvents(id string) ([]HistoryEvent, error) {
	exists, err := scanRowExists(w.db.QueryRow("SELECT id FROM session_logs WHERE id = ?", id))
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, nil
	}
	type partRow struct {
		partNumber int64
		filename   string
	}
	rows, err := w.db.Query(
		"SELECT part_number, filename FROM session_parts WHERE session_id = ? ORDER BY part_number", id,
	)
	if err != nil {
		return nil, err
	}
	parts := []partRow{}
	for rows.Next() {
		var part partRow
		if err := rows.Scan(&part.partNumber, &part.filename); err != nil {
			rows.Close()
			return nil, err
		}
		parts = append(parts, part)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	events := []HistoryEvent{}
	for _, part := range parts {
		file := filepath.Join(w.root, filepath.FromSlash(part.filename))
		compressed, err := os.ReadFile(file)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		raw, err := w.dec.DecodeAll(compressed, nil)
		if err != nil {
			return nil, err
		}
		decoded, _, err := decodeSegment(raw)
		if err != nil {
			return nil, err
		}
		events = append(events, decoded...)
	}
	if writer := w.writers[id]; writer != nil {
		if err := writer.file.Sync(); err != nil {
			return nil, err
		}
		raw, err := os.ReadFile(writer.partialPath)
		if err != nil {
			return nil, err
		}
		decoded, _, err := decodeSegment(raw)
		if err != nil {
			return nil, err
		}
		var after int64
		if len(events) > 0 {
			after = events[len(events)-1].Sequence
		}
		for _, event := range decoded {
			if event.Sequence > after {
				events = append(events, event)
			}
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].Sequence < events[j].Sequence })
	return events, nil
}

func (w *worker) setPinned(id string, pinned bool) (bool, error) {
	result, err := w.db.Exec("UPDATE session_logs SET pinned = ? WHERE id = ?", boolToInt(pinned), id)
	if err != nil {
		return false, err
	}
	if !pinned {
		if err := w.enforceRetention(true); err != nil {
			return false, err
		}
	}
	changes, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return changes > 0, nil
}

func (w *worker) openWriter(sessionID string, part int, policy PartPolicy) (*segmentWriter, error) {
	directory := w.sessionDirectory(sessionID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	partialPath := filepath.Join(directory, partName(part)+".muxlog.partial")
	_, statErr := os.Stat(partialPath)
	exists := statErr == nil
	var file *os.File
	var err error
	if exists {
		file, err = os.OpenFile(partialPath, os.O_WRONLY|os.O_APPEND, 0o600)
	} else {
		file, err = os.OpenFile(partialPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	}
	if err != nil {
		return nil, err
	}
	if !exists {
		if _, err := file.Write(segmentHeader); err != nil {
			file.Close()
			return nil, err
		}
	}
	writer := &segmentWriter{
		sessionID:   sessionID,
		part:        part,
		policy:      policy,
		file:        file,
		partialPath: partialPath,
	}
	w.writers[sessionID] = writer
	return writer, nil
}

func (w *worker) finalizeWriter(sessionID string) error {
	writer := w.writers[sessionID]
	if writer == nil {
		return nil
	}
	delete(w.writers, sessionID)
	if err := writer.file.Sync(); err != nil {
		writer.file.Close()
		return err
	}
	if err := writer.file.Close(); err != nil {
		return err
	}
	if writer.eventCount == 0 {
		return removeIfExists(writer.partialPath)
	}
	relative, err := w.finalizePartial(sessionID, writer.part, writer.partialPath)
	if err != nil {
		return err
	}
	info, err := os.Stat(filepath.Join(w.root, filepath.FromSlash(relative)))
	if err != nil {
		return err
	}
	_, err = w.db.Exec(`
    INSERT INTO session_parts(
      session_id, part_number, filename, raw_bytes, stored_bytes,
      event_count, normalized_bytes, first_sequence, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, part_number) DO UPDATE SET
      filename = excluded.filename,
      raw_bytes = excluded.raw_bytes,
      stored_bytes = excluded.stored_bytes,
      event_count = excluded.event_count,
      normalized_bytes = excluded.normalized_bytes,
      first_sequence = excluded.first_sequence,
      last_sequence = excluded.last_sequence
  `, sessionID, writer.part, relative, writer.rawBytes, info.Size(),
		writer.eventCount, writer.normalizedBytes,
		nullableInt64(writer.firstSequence), nullableInt64(writer.lastSequence))
	return err
}

// finalizePartial truncates any torn trailing frame, compresses the segment,
// and atomically publishes the .zst next to it.
func (w *worker) finalizePartial(sessionID string, part int, partialPath string) (string, error) {
	raw, err := os.ReadFile(partialPath)
	if err != nil {
		return "", err
	}
	_, validEnd, err := decodeSegment(raw)
	if err != nil {
		return "", err
	}
	if validEnd < len(raw) {
		if err := os.Truncate(partialPath, int64(validEnd)); err != nil {
			return "", err
		}
	}
	compressed := w.enc.EncodeAll(raw[:validEnd], nil)
	directory := w.sessionDirectory(sessionID)
	finalPath := filepath.Join(directory, partName(part)+".muxlog.zst")
	temporary := finalPath + ".tmp"
	if err := writeFileSyncing(temporary, compressed, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(temporary, finalPath); err != nil {
		return "", err
	}
	if err := removeIfExists(partialPath); err != nil {
		return "", err
	}
	relative, err := filepath.Rel(w.root, finalPath)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(relative), nil
}

func (w *worker) trimSessionParts(sessionID string, maxParts int) error {
	type partRow struct {
		partNumber                       int64
		filename                         string
		rawBytes, eventCount, normalized int64
	}
	rows, err := w.db.Query(`
    SELECT part_number, filename, raw_bytes, event_count, normalized_bytes
    FROM session_parts WHERE session_id = ? ORDER BY part_number
  `, sessionID)
	if err != nil {
		return err
	}
	parts := []partRow{}
	for rows.Next() {
		var part partRow
		if err := rows.Scan(&part.partNumber, &part.filename, &part.rawBytes,
			&part.eventCount, &part.normalized); err != nil {
			rows.Close()
			return err
		}
		parts = append(parts, part)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	// Reserve one slot for the newly opened active part.
	for len(parts) >= maxParts {
		oldest := parts[0]
		parts = parts[1:]
		if err := removeIfExists(filepath.Join(w.root, filepath.FromSlash(oldest.filename))); err != nil {
			return err
		}
		tx, err := w.db.Begin()
		if err != nil {
			return err
		}
		trim := func() error {
			if _, err := tx.Exec(
				"DELETE FROM transcript_chunks WHERE session_id = ? AND part_number = ?",
				sessionID, oldest.partNumber,
			); err != nil {
				return err
			}
			if _, err := tx.Exec(
				"DELETE FROM session_parts WHERE session_id = ? AND part_number = ?",
				sessionID, oldest.partNumber,
			); err != nil {
				return err
			}
			if _, err := tx.Exec(`
        UPDATE session_logs
        SET raw_bytes = MAX(0, raw_bytes - ?),
            event_count = MAX(0, event_count - ?),
            normalized_bytes = MAX(0, normalized_bytes - ?)
        WHERE id = ?
      `, oldest.rawBytes, oldest.eventCount, oldest.normalized, sessionID); err != nil {
				return err
			}
			return tx.Commit()
		}
		if err := trim(); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return nil
}

func (w *worker) deleteSession(id string, quotaDelete bool) (bool, error) {
	var status string
	err := w.db.QueryRow("SELECT status FROM session_logs WHERE id = ?", id).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && status == "active") {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	directory := w.sessionDirectory(id)
	if _, statErr := os.Stat(directory); statErr == nil {
		trash := filepath.Join(w.trashRoot,
			fmt.Sprintf("%s-%d", safeSessionName(id), time.Now().UnixMilli()))
		if err := os.Rename(directory, trash); err != nil {
			return false, err
		}
		if _, err := w.db.Exec(
			"DELETE FROM session_logs WHERE id = ? AND status <> ?", id, "active",
		); err != nil {
			return false, err
		}
		if err := os.RemoveAll(trash); err != nil {
			return false, err
		}
	} else {
		if _, err := w.db.Exec(
			"DELETE FROM session_logs WHERE id = ? AND status <> ?", id, "active",
		); err != nil {
			return false, err
		}
	}
	if !quotaDelete {
		if _, err := w.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
			return false, err
		}
		if err := w.enforceRetention(false); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (w *worker) enforceRetention(force bool) error {
	now := time.Now()
	if !force && w.bytesSinceQuotaCheck < quotaCheckBytes &&
		now.Sub(w.lastQuotaCheck) < quotaCheckInterval {
		return nil
	}
	w.bytesSinceQuotaCheck = 0
	w.lastQuotaCheck = now

	if w.settings.MaxAgeDays != nil && *w.settings.MaxAgeDays != 0 {
		cutoff := isoMillis(now.Add(-time.Duration(*w.settings.MaxAgeDays) * 24 * time.Hour))
		rows, err := w.db.Query(`
      SELECT id FROM session_logs
      WHERE pinned = 0 AND status <> 'active' AND started_at < ?
      ORDER BY started_at
    `, cutoff)
		if err != nil {
			return err
		}
		expired := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			expired = append(expired, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range expired {
			if _, err := w.deleteSession(id, true); err != nil {
				return err
			}
		}
	}

	disk, err := w.diskStatus()
	if err != nil {
		return err
	}
	reserve := w.settings.MinFreeBytes
	if percentReserve := int64(math.Floor(float64(disk.totalBytes) * w.settings.MinFreePercent / 100)); percentReserve > reserve {
		reserve = percentReserve
	}
	quotaTarget := int64(math.Floor(float64(w.settings.MaxTotalBytes) * 0.85))
	quotaCleanup := disk.usageBytes > w.settings.MaxTotalBytes
	needsCleanup := func() bool {
		limit := w.settings.MaxTotalBytes
		if quotaCleanup {
			limit = quotaTarget
		}
		return disk.freeBytes < reserve || disk.usageBytes > limit
	}
	for needsCleanup() {
		var candidate string
		err := w.db.QueryRow(`
      SELECT id FROM session_logs
      WHERE pinned = 0 AND status <> 'active'
      ORDER BY COALESCE(ended_at, started_at), started_at
      LIMIT 1
    `).Scan(&candidate)
		if errors.Is(err, sql.ErrNoRows) {
			break
		}
		if err != nil {
			return err
		}
		if _, err := w.deleteSession(candidate, true); err != nil {
			return err
		}
		if _, err := w.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
			return err
		}
		if disk, err = w.diskStatus(); err != nil {
			return err
		}
	}
	if disk, err = w.diskStatus(); err != nil {
		return err
	}
	if disk.usageBytes > w.settings.MaxTotalBytes || disk.freeBytes < reserve {
		w.quotaSuspended = true
		w.quotaWarning = "Session logging suspended: history quota or minimum free-space reserve is exhausted. " +
			"Unpin/delete history or raise the storage limit."
	} else {
		w.quotaSuspended = false
		w.quotaWarning = ""
	}
	return nil
}

func (w *worker) storageStatus(configuredLocation string) (api.SessionHistoryStorageStatus, error) {
	var zero api.SessionHistoryStorageStatus
	if err := w.enforceRetention(false); err != nil {
		return zero, err
	}
	disk, err := w.diskStatus()
	if err != nil {
		return zero, err
	}
	restartRequired := false
	if configuredLocation != "" {
		resolved, err := filepath.Abs(configuredLocation)
		if err != nil {
			return zero, err
		}
		restartRequired = filepath.Clean(resolved) != filepath.Clean(w.root)
	}
	return api.SessionHistoryStorageStatus{
		Settings:              w.settings,
		ActiveStorageLocation: w.root,
		UsageBytes:            disk.usageBytes,
		FreeBytes:             disk.freeBytes,
		QuotaSuspended:        w.quotaSuspended,
		Warning:               w.quotaWarning,
		RestartRequired:       restartRequired,
	}, nil
}

type diskInfo struct {
	usageBytes, freeBytes, totalBytes int64
}

func (w *worker) diskStatus() (diskInfo, error) {
	free, total, err := statfsBytes(w.root)
	if err != nil {
		return diskInfo{}, err
	}
	usage, err := directorySize(w.root)
	if err != nil {
		return diskInfo{}, err
	}
	return diskInfo{usageBytes: usage, freeBytes: free, totalBytes: total}, nil
}

func directorySize(directory string) (int64, error) {
	var total int64
	entries, err := os.ReadDir(directory)
	if err != nil {
		return 0, err
	}
	for _, entry := range entries {
		file := filepath.Join(directory, entry.Name())
		if entry.IsDir() {
			size, err := directorySize(file)
			if err != nil {
				return 0, err
			}
			total += size
			continue
		}
		if !entry.Type().IsRegular() {
			continue
		}
		info, err := os.Stat(file)
		if err != nil {
			return 0, err
		}
		total += fileAllocatedSize(info)
	}
	return total, nil
}

func encodeFrame(event HistoryEvent) []byte {
	payloadLength := frameFixedBytes + len(event.Raw)
	frame := make([]byte, 4+payloadLength)
	binary.BigEndian.PutUint32(frame[0:], uint32(payloadLength))
	binary.BigEndian.PutUint64(frame[4:], uint64(event.Sequence))
	recorded, ok := parseTimeMillis(event.RecordedAt)
	if !ok {
		recorded = time.Now().UnixMilli()
	}
	binary.BigEndian.PutUint64(frame[12:], uint64(recorded))
	elapsed := event.ElapsedMs
	if elapsed < 0 {
		elapsed = 0
	}
	binary.BigEndian.PutUint64(frame[20:], uint64(elapsed))
	frame[28] = directionToByte[event.Direction]
	copy(frame[29:], event.Raw)
	return frame
}

// decodeSegment walks frames until the first torn or invalid one; validEnd is
// where the intact prefix stops.
func decodeSegment(data []byte) ([]HistoryEvent, int, error) {
	if len(data) < len(segmentHeader) || !bytes.HasPrefix(data, segmentHeader) {
		return nil, 0, errors.New("invalid muxlog segment header")
	}
	events := []HistoryEvent{}
	offset := len(segmentHeader)
	for offset+4 <= len(data) {
		length := int(binary.BigEndian.Uint32(data[offset:]))
		if length < frameFixedBytes || offset+4+length > len(data) {
			break
		}
		direction, ok := byteToDirection[data[offset+28]]
		if !ok {
			break
		}
		sequence := int64(binary.BigEndian.Uint64(data[offset+4:]))
		recordedMs := int64(binary.BigEndian.Uint64(data[offset+12:]))
		elapsedMs := int64(binary.BigEndian.Uint64(data[offset+20:]))
		events = append(events, HistoryEvent{
			Sequence:   sequence,
			RecordedAt: isoMillis(time.UnixMilli(recordedMs)),
			ElapsedMs:  elapsedMs,
			Direction:  direction,
			Raw:        data[offset+29 : offset+4+length],
			Text:       "",
		})
		offset += 4 + length
	}
	return events, offset, nil
}

func (w *worker) recoverInterruptedSessions() error {
	rows, err := w.db.Query("SELECT id, current_part FROM session_logs WHERE status = 'active'")
	if err != nil {
		return err
	}
	active := []string{}
	for rows.Next() {
		var id string
		var currentPart int64
		if err := rows.Scan(&id, &currentPart); err != nil {
			rows.Close()
			return err
		}
		active = append(active, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range active {
		directory := w.sessionDirectory(id)
		if entries, dirErr := os.ReadDir(directory); dirErr == nil {
			for _, entry := range entries {
				match := partialNamePattern.FindStringSubmatch(entry.Name())
				if match == nil {
					continue
				}
				part := 0
				fmt.Sscanf(match[1], "%d", &part)
				partial := filepath.Join(directory, entry.Name())
				raw, err := os.ReadFile(partial)
				if err != nil {
					return err
				}
				decoded, _, err := decodeSegment(raw)
				if err != nil {
					return err
				}
				if len(decoded) == 0 {
					if err := removeIfExists(partial); err != nil {
						return err
					}
					continue
				}
				relative, err := w.finalizePartial(id, part, partial)
				if err != nil {
					return err
				}
				var rawBytes int64
				for _, event := range decoded {
					rawBytes += int64(len(event.Raw))
				}
				var normalized int64
				if err := w.db.QueryRow(`
          SELECT COALESCE(SUM(length(CAST(normalized_text AS BLOB))), 0) AS bytes
          FROM transcript_chunks WHERE session_id = ? AND part_number = ?
        `, id, part).Scan(&normalized); err != nil {
					return err
				}
				info, err := os.Stat(filepath.Join(w.root, filepath.FromSlash(relative)))
				if err != nil {
					return err
				}
				if _, err := w.db.Exec(`
          INSERT OR REPLACE INTO session_parts(
            session_id, part_number, filename, raw_bytes, stored_bytes,
            event_count, normalized_bytes, first_sequence, last_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, id, part, relative, rawBytes, info.Size(), len(decoded), normalized,
					decoded[0].Sequence, decoded[len(decoded)-1].Sequence); err != nil {
					return err
				}
			}
		}
		if _, err := w.db.Exec(`
      UPDATE session_logs
      SET status = 'disconnected',
          ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
          paused = 0,
          current_part_bytes = 0
      WHERE id = ?
    `, id); err != nil {
			return err
		}
	}
	return nil
}

// importLegacyHistory moves the pre-v10 BLOB-backed history tables from the
// application database into the split history store. The application
// database drops those tables only after Open returns successfully, so a
// failed import is retryable on the next launch.
func (w *worker) importLegacyHistory(legacyFile string) (returnErr error) {
	if _, err := os.Stat(legacyFile); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	legacyAbs, err := filepath.Abs(legacyFile)
	if err != nil {
		return err
	}
	historyAbs, err := filepath.Abs(w.databaseFile)
	if err != nil {
		return err
	}
	if filepath.Clean(legacyAbs) == filepath.Clean(historyAbs) {
		return nil
	}
	if _, err := w.db.Exec("ATTACH DATABASE ? AS legacy", legacyAbs); err != nil {
		return err
	}
	defer func() {
		if _, err := w.db.Exec("DETACH DATABASE legacy"); returnErr == nil && err != nil {
			returnErr = err
		}
	}()

	var table string
	err = w.db.QueryRow(`
      SELECT name FROM legacy.sqlite_master
      WHERE type = 'table' AND name = 'session_logs'
    `).Scan(&table)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	type legacySession struct {
		id, profileKey, title, kind, host, startedAt string
		endedAt                                      sql.NullString
		status                                       string
		captureInput                                 int
	}
	rows, err := w.db.Query(`
      SELECT id, profile_key, title, kind, host, started_at, ended_at,
             status, capture_input
      FROM legacy.session_logs ORDER BY started_at
    `)
	if err != nil {
		return err
	}
	sessions := []legacySession{}
	for rows.Next() {
		var session legacySession
		if err := rows.Scan(
			&session.id, &session.profileKey, &session.title, &session.kind,
			&session.host, &session.startedAt, &session.endedAt,
			&session.status, &session.captureInput,
		); err != nil {
			rows.Close()
			return err
		}
		sessions = append(sessions, session)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}

	type legacyEvent struct {
		part                        int
		sequence, elapsedMs         int64
		recordedAt, direction, text string
		raw                         []byte
	}
	for _, session := range sessions {
		exists, err := scanRowExists(w.db.QueryRow(
			"SELECT id FROM session_logs WHERE id = ?", session.id,
		))
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		status := session.status
		if status == "active" {
			status = "disconnected"
		}
		if _, err := w.db.Exec(`
        INSERT INTO session_logs(
          id, profile_key, title, kind, host, started_at, ended_at, status,
          paused, capture_input, event_count, raw_bytes, normalized_bytes,
          current_part, current_part_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 1, 0)
      `, session.id, session.profileKey, session.title, session.kind,
			session.host, session.startedAt, nullableString(session.endedAt),
			status, session.captureInput); err != nil {
			return err
		}

		eventRows, err := w.db.Query(`
        SELECT part_number, sequence, recorded_at, elapsed_ms, direction,
               raw_data, normalized_text
        FROM legacy.session_log_events
        WHERE session_id = ? ORDER BY part_number, sequence
      `, session.id)
		if err != nil {
			return err
		}
		events := []legacyEvent{}
		for eventRows.Next() {
			var event legacyEvent
			if err := eventRows.Scan(
				&event.part, &event.sequence, &event.recordedAt,
				&event.elapsedMs, &event.direction, &event.raw, &event.text,
			); err != nil {
				eventRows.Close()
				return err
			}
			event.raw = append([]byte(nil), event.raw...)
			events = append(events, event)
		}
		if err := eventRows.Close(); err != nil {
			return err
		}
		if err := eventRows.Err(); err != nil {
			return err
		}

		var currentPart int
		var partialPath string
		var file *os.File
		var rawBytes, normalizedBytes, eventCount int64
		var firstSequence, lastSequence int64
		finishPart := func() error {
			if file == nil {
				return nil
			}
			if err := file.Sync(); err != nil {
				_ = file.Close()
				return err
			}
			if err := file.Close(); err != nil {
				return err
			}
			file = nil
			relative, err := w.finalizePartial(session.id, currentPart, partialPath)
			if err != nil {
				return err
			}
			info, err := os.Stat(filepath.Join(w.root, filepath.FromSlash(relative)))
			if err != nil {
				return err
			}
			_, err = w.db.Exec(`
          INSERT INTO session_parts(
            session_id, part_number, filename, raw_bytes, stored_bytes,
            event_count, normalized_bytes, first_sequence, last_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, session.id, currentPart, relative, rawBytes, info.Size(),
				eventCount, normalizedBytes, firstSequence, lastSequence)
			return err
		}
		for _, event := range events {
			if event.part != currentPart {
				if err := finishPart(); err != nil {
					return err
				}
				currentPart = event.part
				directory := w.sessionDirectory(session.id)
				if err := os.MkdirAll(directory, 0o700); err != nil {
					return err
				}
				partialPath = filepath.Join(directory, partName(currentPart)+".muxlog.partial")
				file, err = os.OpenFile(
					partialPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600,
				)
				if err != nil {
					return err
				}
				if _, err := file.Write(segmentHeader); err != nil {
					_ = file.Close()
					return err
				}
				rawBytes = 0
				normalizedBytes = 0
				eventCount = 0
				firstSequence = event.sequence
			}
			frame := encodeFrame(HistoryEvent{
				Sequence: event.sequence, RecordedAt: event.recordedAt,
				ElapsedMs: event.elapsedMs, Direction: event.direction, Raw: event.raw,
			})
			if _, err := file.Write(frame); err != nil {
				_ = file.Close()
				return err
			}
			rawBytes += int64(len(event.raw))
			normalizedBytes += int64(len([]byte(event.text)))
			eventCount++
			lastSequence = event.sequence
			if event.text != "" {
				if _, err := w.db.Exec(`
            INSERT INTO transcript_chunks(
              session_id, part_number, first_sequence, last_sequence,
              recorded_at, elapsed_ms, direction, normalized_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, session.id, event.part, event.sequence, event.sequence,
					event.recordedAt, event.elapsedMs, event.direction, event.text); err != nil {
					_ = file.Close()
					return err
				}
			}
		}
		if err := finishPart(); err != nil {
			return err
		}
		var totalRaw, totalNormalized, totalEvents int64
		currentPart = 1
		if err := w.db.QueryRow(`
        SELECT COALESCE(SUM(raw_bytes), 0),
               COALESCE(SUM(normalized_bytes), 0),
               COALESCE(SUM(event_count), 0),
               COALESCE(MAX(part_number), 1)
        FROM session_parts WHERE session_id = ?
      `, session.id).Scan(
			&totalRaw, &totalNormalized, &totalEvents, &currentPart,
		); err != nil {
			return err
		}
		if _, err := w.db.Exec(`
        UPDATE session_logs
        SET raw_bytes = ?, normalized_bytes = ?, event_count = ?,
            current_part = ?, current_part_bytes = 0
        WHERE id = ?
      `, totalRaw, totalNormalized, totalEvents, currentPart, session.id); err != nil {
			return err
		}
	}
	return nil
}

func (w *worker) removeTrash() error {
	entries, err := os.ReadDir(w.trashRoot)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(w.trashRoot, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func nullableString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func (w *worker) closeWorker() error {
	if w.closed {
		return nil
	}
	w.closed = true
	ids := make([]string, 0, len(w.writers))
	for id := range w.writers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var firstErr error
	for _, id := range ids {
		if err := w.finalizeWriter(id); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if w.db != nil {
		if _, err := w.db.Exec(`
      UPDATE session_logs
      SET status = 'disconnected',
          ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
          paused = 0,
          current_part_bytes = 0
      WHERE status = 'active';
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA optimize;
    `); err != nil && firstErr == nil {
			firstErr = err
		}
		if err := w.db.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if w.dec != nil {
		w.dec.Close()
	}
	if w.enc != nil {
		_ = w.enc.Close()
	}
	return firstErr
}

func (w *worker) quotaWarningOrDefault() string {
	if w.quotaWarning != "" {
		return w.quotaWarning
	}
	return "session history quota is exhausted"
}

func (w *worker) sessionDirectory(id string) string {
	return filepath.Join(w.sessionsRoot, safeSessionName(id))
}

func safeSessionName(id string) string {
	if safeSessionNamePattern.MatchString(id) {
		return id
	}
	return base64.RawURLEncoding.EncodeToString([]byte(id))
}

func partName(part int) string {
	return fmt.Sprintf("%06d", part)
}

func ftsExpression(value string) string {
	tokens := strings.Fields(strings.TrimSpace(value))
	if len(tokens) == 0 {
		return ""
	}
	quoted := make([]string, len(tokens))
	for i, token := range tokens {
		quoted[i] = `"` + strings.ReplaceAll(token, `"`, `""`) + `"`
	}
	return strings.Join(quoted, " AND ")
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

type cursor struct {
	startedAt string
	id        string
}

func encodeCursor(startedAt, id string) string {
	payload, _ := json.Marshal([]string{startedAt, id})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeCursor(value string) *cursor {
	if value == "" {
		return nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(value, "="))
	if err != nil {
		return nil
	}
	var parsed []any
	if err := json.Unmarshal(decoded, &parsed); err != nil || len(parsed) < 2 {
		return nil
	}
	startedAt, okStarted := parsed[0].(string)
	id, okID := parsed[1].(string)
	if !okStarted || !okID {
		return nil
	}
	return &cursor{startedAt: startedAt, id: id}
}

// isoMillis matches Date.prototype.toISOString: millisecond precision, UTC.
func isoMillis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000") + "Z"
}

func parseTimeMillis(value string) (int64, bool) {
	if t, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return t.UnixMilli(), true
	}
	return 0, false
}

func writeFileSyncing(path string, data []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func removeIfExists(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func nullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func scanRowExists(row *sql.Row) (bool, error) {
	var probe string
	err := row.Scan(&probe)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
