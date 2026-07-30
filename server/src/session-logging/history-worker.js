import {
  chmodSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const port = parentPort;
if (!port) throw new Error('session history worker requires a parent port');

const root = String(workerData.root);
let settings = workerData.settings;
const databaseFile = path.join(root, 'session-history.sqlite');
const sessionsRoot = path.join(root, 'sessions');
const trashRoot = path.join(root, '.trash');
const SEGMENT_HEADER = Buffer.from([0x4d, 0x55, 0x58, 0x4c, 0x4f, 0x47, 0x01, 0x0a]);
const DIRECTION_TO_BYTE = { input: 1, output: 2, system: 3 };
const BYTE_TO_DIRECTION = { 1: 'input', 2: 'output', 3: 'system' };
const QUOTA_CHECK_BYTES = 1024 * 1024;
const QUOTA_CHECK_INTERVAL_MS = 2_000;
const writers = new Map();
let bytesSinceQuotaCheck = 0;
let lastQuotaCheck = 0;
let quotaSuspended = false;
let quotaWarning;
let closed = false;

mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(databaseFile);
try {
  chmodSync(databaseFile, 0o600);
} catch {
  // Some filesystems own permission policy.
}
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

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
`);

removeTrash();
if (workerData.legacyDatabasePath && workerData.legacyDatabasePath !== ':memory:') {
  importLegacyHistory(String(workerData.legacyDatabasePath));
}
recoverInterruptedSessions();
enforceRetention(true);

const maintenanceTimer = setInterval(() => {
  try {
    enforceRetention(true);
    db.exec('PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;');
  } catch {
    // A later write/status request will surface persistent storage failures.
  }
}, 30 * 60 * 1000);
maintenanceTimer.unref();

port.on('message', (message) => {
  const { id, op, payload } = message;
  try {
    const value = dispatch(op, payload);
    port.postMessage({ id, ok: true, value });
  } catch (error) {
    port.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

function dispatch(op, payload) {
  switch (op) {
    case 'ready':
      return true;
    case 'begin':
      return beginSession(payload);
    case 'append':
      return appendEvents(payload);
    case 'set-state':
      return setSessionState(payload);
    case 'finish':
      return finishSession(payload);
    case 'search':
      return search(payload);
    case 'detail':
      return detail(payload);
    case 'raw':
      return rawEvents(payload.id);
    case 'delete':
      return deleteSession(payload.id, false);
    case 'pin':
      return setPinned(payload.id, payload.pinned);
    case 'settings':
      settings = payload;
      enforceRetention(true);
      return true;
    case 'status':
      return storageStatus(payload);
    case 'close':
      closeWorker();
      return true;
    default:
      throw new Error(`unknown session history operation: ${op}`);
  }
}

function beginSession({ id, input, policy }) {
  enforceRetention(false);
  if (quotaSuspended) throw new Error(quotaWarning ?? 'session history quota is exhausted');
  db.prepare(`
    INSERT INTO session_logs(
      id, profile_key, title, kind, host, started_at, status, capture_input
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    id,
    input.profileKey,
    input.title,
    input.kind,
    input.host,
    input.startedAt,
    input.captureInput ? 1 : 0,
  );
  openWriter(id, 1, policy);
  return true;
}

function appendEvents({ sessionId, events, policy }) {
  if (quotaSuspended) throw new Error(quotaWarning ?? 'session history quota is exhausted');
  const session = db
    .prepare(`SELECT status, current_part, current_part_bytes FROM session_logs WHERE id = ?`)
    .get(sessionId);
  if (!session || session.status !== 'active') return false;
  let writer = writers.get(sessionId) ?? openWriter(sessionId, Number(session.current_part), policy);
  const retained = [];
  let rawBytes = 0;
  let normalizedBytes = 0;
  for (const event of events) {
    const raw = Buffer.from(event.raw);
    const frame = encodeFrame(event, raw);
    if (
      writer.eventCount > 0 &&
      writer.rawBytes + raw.byteLength > policy.maxPartBytes
    ) {
      finalizeWriter(sessionId);
      writer = openWriter(sessionId, writer.part + 1, policy);
      trimSessionParts(sessionId, policy.maxParts);
    }
    writeSync(writer.fd, frame);
    writer.rawBytes += raw.byteLength;
    writer.eventCount += 1;
    writer.firstSequence ??= event.sequence;
    writer.lastSequence = event.sequence;
    rawBytes += raw.byteLength;
    const textBytes = Buffer.byteLength(event.text, 'utf8');
    writer.normalizedBytes += textBytes;
    normalizedBytes += textBytes;
    retained.push({ ...event, part: writer.part });
  }
  // One SQLite transaction per recorder batch (normally every 250 ms).
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`
      INSERT INTO transcript_chunks(
        session_id, part_number, first_sequence, last_sequence,
        recorded_at, elapsed_ms, direction, normalized_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of retained) {
      if (!event.text) continue;
      insert.run(
        sessionId,
        event.part,
        event.sequence,
        event.sequence,
        event.recordedAt,
        event.elapsedMs,
        event.direction,
        event.text,
      );
    }
    db.prepare(`
      UPDATE session_logs
      SET current_part = ?,
          current_part_bytes = ?,
          event_count = event_count + ?,
          raw_bytes = raw_bytes + ?,
          normalized_bytes = normalized_bytes + ?
      WHERE id = ? AND status = 'active'
    `).run(
      writer.part,
      writer.rawBytes,
      events.length,
      rawBytes,
      normalizedBytes,
      sessionId,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  bytesSinceQuotaCheck += rawBytes + normalizedBytes;
  if (
    bytesSinceQuotaCheck >= QUOTA_CHECK_BYTES ||
    Date.now() - lastQuotaCheck >= QUOTA_CHECK_INTERVAL_MS
  ) {
    enforceRetention(false);
  }
  if (quotaSuspended) throw new Error(quotaWarning);
  return true;
}

function setSessionState({ sessionId, patch }) {
  const row = db
    .prepare('SELECT paused, capture_input FROM session_logs WHERE id = ?')
    .get(sessionId);
  if (!row) return false;
  db.prepare(`UPDATE session_logs SET paused = ?, capture_input = ? WHERE id = ?`)
    .run(
      patch.paused === undefined ? Number(row.paused) : patch.paused ? 1 : 0,
      patch.captureInput === undefined
        ? Number(row.capture_input)
        : patch.captureInput
          ? 1
          : 0,
      sessionId,
    );
  return true;
}

function finishSession({ sessionId, status, endedAt }) {
  finalizeWriter(sessionId);
  db.prepare(`
    UPDATE session_logs
    SET status = ?, ended_at = ?, paused = 0, current_part_bytes = 0
    WHERE id = ? AND status = 'active'
  `).run(status, endedAt, sessionId);
  enforceRetention(true);
  return true;
}

function search(input) {
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 50));
  const args = [];
  const filters = [];
  let withSql = '';
  let joinSql = '';
  let selectSnippet = 'NULL AS snippet';
  const expression = ftsExpression(input.query);
  if (expression) {
    withSql = `
      WITH event_matches AS (
        SELECT chunks.session_id, MIN(chunks.id) AS match_id, COUNT(*) AS match_count
        FROM transcript_chunks_fts
        JOIN transcript_chunks AS chunks ON chunks.id = transcript_chunks_fts.rowid
        WHERE transcript_chunks_fts MATCH ?
        GROUP BY chunks.session_id
      )
    `;
    args.push(expression);
    joinSql = `
      LEFT JOIN event_matches ON event_matches.session_id = logs.id
    `;
    // snippet() centers the excerpt on the matched tokens; char(1)/char(2)
    // delimit the highlight so the client never parses transcript text as markup.
    // Placeholders bind in textual order: CTE match, snippet match, then filters.
    selectSnippet = `(
      SELECT snippet(transcript_chunks_fts, 0, char(1), char(2), '…', 16)
      FROM transcript_chunks_fts
      WHERE transcript_chunks_fts.rowid = event_matches.match_id
        AND transcript_chunks_fts MATCH ?
    ) AS snippet, event_matches.match_count AS match_count`;
    args.push(expression);
    const metadata = `%${escapeLike(input.query.trim())}%`;
    filters.push(`(
      event_matches.session_id IS NOT NULL
      OR logs.title LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR logs.host LIKE ? ESCAPE '\\' COLLATE NOCASE
    )`);
    args.push(metadata, metadata);
  }
  if (input.profileKey) {
    filters.push('logs.profile_key = ?');
    args.push(input.profileKey);
  }
  if (input.host) {
    filters.push(`logs.host LIKE ? ESCAPE '\\' COLLATE NOCASE`);
    args.push(`%${escapeLike(input.host)}%`);
  }
  if (input.kind) {
    filters.push('logs.kind = ?');
    args.push(input.kind);
  }
  if (input.startedAfter) {
    filters.push('logs.started_at >= ?');
    args.push(input.startedAfter);
  }
  if (input.startedBefore) {
    filters.push('logs.started_at <= ?');
    args.push(input.startedBefore);
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) {
    filters.push('(logs.started_at < ? OR (logs.started_at = ? AND logs.id < ?))');
    args.push(cursor.startedAt, cursor.startedAt, cursor.id);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db.prepare(`
    ${withSql}
    SELECT logs.*, ${selectSnippet}, (
      SELECT COUNT(*) FROM session_parts AS parts WHERE parts.session_id = logs.id
    ) AS retained_part_count
    FROM session_logs AS logs
    ${joinSql}
    ${where}
    ORDER BY logs.started_at DESC, logs.id DESC
    LIMIT ?
  `).all(...args, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    sessions: page.map(summaryFromRow),
    nextCursor:
      hasMore && last
        ? encodeCursor(String(last.started_at), String(last.id))
        : undefined,
  };
}

function detail({ id, eventLimit, matchQuery }) {
  const row = db.prepare(`
    SELECT logs.*, NULL AS snippet, (
      SELECT COUNT(*) FROM session_parts AS parts WHERE parts.session_id = logs.id
    ) AS retained_part_count
    FROM session_logs AS logs WHERE logs.id = ?
  `).get(id);
  if (!row) return undefined;
  const countRow = db
    .prepare('SELECT COUNT(*) AS total FROM transcript_chunks WHERE session_id = ?')
    .get(id);
  const totalChunks = Number(countRow?.total ?? 0);
  const limited = eventLimit !== undefined;
  const windowStart = limited
    ? matchWindowStart(id, matchQuery, eventLimit, totalChunks)
    : undefined;
  const rows = db.prepare(
    windowStart !== undefined
      ? `
        SELECT first_sequence, recorded_at, elapsed_ms, direction, normalized_text
        FROM transcript_chunks WHERE session_id = ? AND first_sequence >= ?
        ORDER BY first_sequence LIMIT ?
      `
      : limited
        ? `
          SELECT * FROM (
            SELECT first_sequence, recorded_at, elapsed_ms, direction, normalized_text
            FROM transcript_chunks WHERE session_id = ?
            ORDER BY first_sequence DESC LIMIT ?
          ) ORDER BY first_sequence
        `
        : `
          SELECT first_sequence, recorded_at, elapsed_ms, direction, normalized_text
          FROM transcript_chunks WHERE session_id = ? ORDER BY first_sequence
        `,
  ).all(
    ...(windowStart !== undefined
      ? [id, windowStart, eventLimit]
      : limited
        ? [id, eventLimit]
        : [id]),
  );
  return {
    ...summaryFromRow(row),
    events: rows.map((event) => ({
      sequence: Number(event.first_sequence),
      recordedAt: String(event.recorded_at),
      elapsedMs: Number(event.elapsed_ms),
      direction: String(event.direction),
      text: String(event.normalized_text),
    })),
    eventsTruncated: rows.length < totalChunks,
  };
}

/** Leading context retained before the first match when anchoring a preview. */
const MATCH_CONTEXT_CHUNKS = 50;

/**
 * When a preview is opened from a search hit, anchor the limited event window
 * on the first matching chunk (with some leading context) instead of the
 * newest events, so the match is actually visible in the preview.
 * Returns the first_sequence to start from, or undefined to keep the
 * default newest-events window.
 */
function matchWindowStart(sessionId, matchQuery, eventLimit, totalChunks) {
  if (!eventLimit || totalChunks <= eventLimit) return undefined;
  const expression = ftsExpression(matchQuery);
  if (!expression) return undefined;
  const match = db.prepare(`
    SELECT MIN(chunks.first_sequence) AS seq
    FROM transcript_chunks_fts
    JOIN transcript_chunks AS chunks ON chunks.id = transcript_chunks_fts.rowid
    WHERE transcript_chunks_fts MATCH ? AND chunks.session_id = ?
  `).get(expression, sessionId);
  if (match?.seq === null || match?.seq === undefined) return undefined;
  const matchSeq = Number(match.seq);
  const newestWindow = db.prepare(`
    SELECT MIN(first_sequence) AS seq FROM (
      SELECT first_sequence FROM transcript_chunks
      WHERE session_id = ? ORDER BY first_sequence DESC LIMIT ?
    )
  `).get(sessionId, eventLimit);
  if (newestWindow?.seq !== null && matchSeq >= Number(newestWindow?.seq)) {
    return undefined;
  }
  // Context is capped at half the window so the match itself always fits.
  const contextRows = Math.min(MATCH_CONTEXT_CHUNKS, Math.floor(eventLimit / 2));
  if (contextRows < 1) return matchSeq;
  const context = db.prepare(`
    SELECT first_sequence FROM transcript_chunks
    WHERE session_id = ? AND first_sequence < ?
    ORDER BY first_sequence DESC LIMIT 1 OFFSET ?
  `).get(sessionId, matchSeq, contextRows - 1);
  return context ? Number(context.first_sequence) : 0;
}

function rawEvents(id) {
  if (!db.prepare('SELECT id FROM session_logs WHERE id = ?').get(id)) return undefined;
  const events = [];
  const parts = db
    .prepare('SELECT part_number, filename FROM session_parts WHERE session_id = ? ORDER BY part_number')
    .all(id);
  for (const part of parts) {
    const file = path.join(root, String(part.filename));
    if (!existsSync(file)) continue;
    const decoded = decodeSegment(zstdDecompressSync(readFileSync(file)));
    events.push(...decoded.events);
  }
  const writer = writers.get(id);
  if (writer) {
    fdatasyncSync(writer.fd);
    const decoded = decodeSegment(readFileSync(writer.partialPath));
    const after = events.at(-1)?.sequence ?? 0;
    events.push(...decoded.events.filter((event) => event.sequence > after));
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}

function setPinned(id, pinned) {
  const result = db
    .prepare(`UPDATE session_logs SET pinned = ? WHERE id = ?`)
    .run(pinned ? 1 : 0, id);
  if (!pinned) enforceRetention(true);
  return result.changes > 0;
}

function openWriter(sessionId, part, policy) {
  const directory = sessionDirectory(sessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const partialPath = path.join(directory, `${partName(part)}.muxlog.partial`);
  const exists = existsSync(partialPath);
  const fd = openSync(partialPath, exists ? 'a' : 'wx', 0o600);
  if (!exists) writeSync(fd, SEGMENT_HEADER);
  const writer = {
    sessionId,
    part,
    policy,
    fd,
    partialPath,
    rawBytes: 0,
    normalizedBytes: 0,
    eventCount: 0,
    firstSequence: undefined,
    lastSequence: undefined,
  };
  writers.set(sessionId, writer);
  return writer;
}

function finalizeWriter(sessionId) {
  const writer = writers.get(sessionId);
  if (!writer) return;
  writers.delete(sessionId);
  fdatasyncSync(writer.fd);
  closeSync(writer.fd);
  if (writer.eventCount === 0) {
    rmSync(writer.partialPath, { force: true });
    return;
  }
  const relative = finalizePartial(
    sessionId,
    writer.part,
    writer.partialPath,
  );
  const storedBytes = statSync(path.join(root, relative)).size;
  db.prepare(`
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
  `).run(
    sessionId,
    writer.part,
    relative,
    writer.rawBytes,
    storedBytes,
    writer.eventCount,
    writer.normalizedBytes,
    writer.firstSequence ?? null,
    writer.lastSequence ?? null,
  );
}

function finalizePartial(sessionId, part, partialPath) {
  const raw = readFileSync(partialPath);
  const decoded = decodeSegment(raw);
  if (decoded.validEnd < raw.byteLength) truncateSync(partialPath, decoded.validEnd);
  const valid = decoded.validEnd === raw.byteLength ? raw : raw.subarray(0, decoded.validEnd);
  const compressed = zstdCompressSync(valid);
  const directory = sessionDirectory(sessionId);
  const finalPath = path.join(directory, `${partName(part)}.muxlog.zst`);
  const temporary = `${finalPath}.tmp`;
  writeFileSync(temporary, compressed, { mode: 0o600, flush: true });
  renameSync(temporary, finalPath);
  rmSync(partialPath, { force: true });
  return path.relative(root, finalPath);
}

function trimSessionParts(sessionId, maxParts) {
  let parts = db
    .prepare(`
      SELECT part_number, filename, raw_bytes, event_count, normalized_bytes
      FROM session_parts WHERE session_id = ? ORDER BY part_number
    `)
    .all(sessionId);
  // Reserve one slot for the newly opened active part.
  while (parts.length >= maxParts) {
    const oldest = parts.shift();
    if (!oldest) break;
    rmSync(path.join(root, String(oldest.filename)), { force: true });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM transcript_chunks WHERE session_id = ? AND part_number = ?')
        .run(sessionId, oldest.part_number);
      db.prepare('DELETE FROM session_parts WHERE session_id = ? AND part_number = ?')
        .run(sessionId, oldest.part_number);
      db.prepare(`
        UPDATE session_logs
        SET raw_bytes = MAX(0, raw_bytes - ?),
            event_count = MAX(0, event_count - ?),
            normalized_bytes = MAX(0, normalized_bytes - ?)
        WHERE id = ?
      `).run(
        oldest.raw_bytes,
        oldest.event_count,
        oldest.normalized_bytes,
        sessionId,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function deleteSession(id, quotaDelete) {
  const row = db
    .prepare('SELECT status FROM session_logs WHERE id = ?')
    .get(id);
  if (!row || row.status === 'active') return false;
  const directory = sessionDirectory(id);
  if (existsSync(directory)) {
    const trash = path.join(trashRoot, `${safeSessionName(id)}-${Date.now()}`);
    renameSync(directory, trash);
    db.prepare('DELETE FROM session_logs WHERE id = ? AND status <> ?')
      .run(id, 'active');
    rmSync(trash, { recursive: true, force: true });
  } else {
    db.prepare('DELETE FROM session_logs WHERE id = ? AND status <> ?')
      .run(id, 'active');
  }
  if (!quotaDelete) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    enforceRetention(false);
  }
  return true;
}

function enforceRetention(force) {
  const now = Date.now();
  if (
    !force &&
    bytesSinceQuotaCheck < QUOTA_CHECK_BYTES &&
    now - lastQuotaCheck < QUOTA_CHECK_INTERVAL_MS
  ) return;
  bytesSinceQuotaCheck = 0;
  lastQuotaCheck = now;

  if (settings.maxAgeDays) {
    const cutoff = new Date(now - settings.maxAgeDays * 86_400_000).toISOString();
    const expired = db.prepare(`
      SELECT id FROM session_logs
      WHERE pinned = 0 AND status <> 'active' AND started_at < ?
      ORDER BY started_at
    `).all(cutoff);
    for (const row of expired) deleteSession(String(row.id), true);
  }

  let disk = diskStatus();
  const reserve = Math.max(
    Number(settings.minFreeBytes),
    Math.floor(disk.totalBytes * Number(settings.minFreePercent) / 100),
  );
  const quotaTarget = Math.floor(Number(settings.maxTotalBytes) * 0.85);
  const quotaCleanup = disk.usageBytes > Number(settings.maxTotalBytes);
  const needsCleanup = () =>
    disk.freeBytes < reserve ||
    disk.usageBytes > (quotaCleanup ? quotaTarget : Number(settings.maxTotalBytes));
  while (needsCleanup()) {
    const candidate = db.prepare(`
      SELECT id FROM session_logs
      WHERE pinned = 0 AND status <> 'active'
      ORDER BY COALESCE(ended_at, started_at), started_at
      LIMIT 1
    `).get();
    if (!candidate) break;
    deleteSession(String(candidate.id), true);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    disk = diskStatus();
  }
  disk = diskStatus();
  if (
    disk.usageBytes > Number(settings.maxTotalBytes) ||
    disk.freeBytes < reserve
  ) {
    quotaSuspended = true;
    quotaWarning =
      'Session logging suspended: history quota or minimum free-space reserve is exhausted. ' +
      'Unpin/delete history or raise the storage limit.';
  } else {
    quotaSuspended = false;
    quotaWarning = undefined;
  }
}

function storageStatus({ configuredLocation }) {
  enforceRetention(false);
  const disk = diskStatus();
  return {
    settings,
    activeStorageLocation: root,
    usageBytes: disk.usageBytes,
    freeBytes: disk.freeBytes,
    quotaSuspended,
    warning: quotaWarning,
    restartRequired:
      !!configuredLocation && path.resolve(configuredLocation) !== path.resolve(root),
  };
}

function diskStatus() {
  const stats = statfsSync(root);
  return {
    usageBytes: directorySize(root),
    freeBytes: Number(stats.bavail) * Number(stats.bsize),
    totalBytes: Number(stats.blocks) * Number(stats.bsize),
  };
}

function directorySize(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(file);
    else if (entry.isFile()) {
      const stats = statSync(file);
      // POSIX st_blocks measures allocated 512-byte units (including sparse
      // files accurately). Platforms without it fall back to logical size.
      total += stats.blocks === undefined ? stats.size : stats.blocks * 512;
    }
  }
  return total;
}

function encodeFrame(event, raw) {
  const payloadLength = 25 + raw.byteLength;
  const frame = Buffer.allocUnsafe(4 + payloadLength);
  frame.writeUInt32BE(payloadLength, 0);
  frame.writeBigUInt64BE(BigInt(event.sequence), 4);
  const recorded = Date.parse(event.recordedAt);
  frame.writeBigUInt64BE(BigInt(Number.isFinite(recorded) ? recorded : Date.now()), 12);
  frame.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(event.elapsedMs))), 20);
  frame[28] = DIRECTION_TO_BYTE[event.direction];
  raw.copy(frame, 29);
  return frame;
}

function decodeSegment(data) {
  if (
    data.byteLength < SEGMENT_HEADER.byteLength ||
    !data.subarray(0, SEGMENT_HEADER.byteLength).equals(SEGMENT_HEADER)
  ) {
    throw new Error('invalid muxlog segment header');
  }
  const events = [];
  let offset = SEGMENT_HEADER.byteLength;
  while (offset + 4 <= data.byteLength) {
    const length = data.readUInt32BE(offset);
    if (length < 25 || offset + 4 + length > data.byteLength) break;
    const direction = BYTE_TO_DIRECTION[data[offset + 28]];
    if (!direction) break;
    const sequence = Number(data.readBigUInt64BE(offset + 4));
    const recordedMs = Number(data.readBigUInt64BE(offset + 12));
    const elapsedMs = Number(data.readBigUInt64BE(offset + 20));
    events.push({
      sequence,
      recordedAt: new Date(recordedMs).toISOString(),
      elapsedMs,
      direction,
      raw: data.subarray(offset + 29, offset + 4 + length),
      text: '',
    });
    offset += 4 + length;
  }
  return { events, validEnd: offset };
}

function recoverInterruptedSessions() {
  const active = db.prepare(`SELECT id, current_part FROM session_logs WHERE status = 'active'`).all();
  for (const row of active) {
    const id = String(row.id);
    const directory = sessionDirectory(id);
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory)) {
        const match = /^(\d{6})\.muxlog\.partial$/.exec(entry);
        if (!match) continue;
        const part = Number(match[1]);
        const partial = path.join(directory, entry);
        const decoded = decodeSegment(readFileSync(partial));
        if (decoded.events.length === 0) {
          rmSync(partial, { force: true });
          continue;
        }
        const relative = finalizePartial(id, part, partial);
        const rawBytes = decoded.events.reduce((sum, event) => sum + event.raw.byteLength, 0);
        const normalized = db.prepare(`
          SELECT COALESCE(SUM(length(CAST(normalized_text AS BLOB))), 0) AS bytes
          FROM transcript_chunks WHERE session_id = ? AND part_number = ?
        `).get(id, part);
        db.prepare(`
          INSERT OR REPLACE INTO session_parts(
            session_id, part_number, filename, raw_bytes, stored_bytes,
            event_count, normalized_bytes, first_sequence, last_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          part,
          relative,
          rawBytes,
          statSync(path.join(root, relative)).size,
          decoded.events.length,
          Number(normalized?.bytes ?? 0),
          decoded.events[0]?.sequence ?? null,
          decoded.events.at(-1)?.sequence ?? null,
        );
      }
    }
    db.prepare(`
      UPDATE session_logs
      SET status = 'disconnected',
          ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
          paused = 0,
          current_part_bytes = 0
      WHERE id = ?
    `).run(id);
  }
}

function importLegacyHistory(legacyFile) {
  if (!existsSync(legacyFile) || path.resolve(legacyFile) === path.resolve(databaseFile)) return;
  db.exec(`ATTACH DATABASE ${sqlString(legacyFile)} AS legacy`);
  try {
    const table = db
      .prepare(`SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = 'session_logs'`)
      .get();
    if (!table) return;
    const sessions = db.prepare('SELECT * FROM legacy.session_logs ORDER BY started_at').all();
    for (const session of sessions) {
      const id = String(session.id);
      if (db.prepare('SELECT id FROM session_logs WHERE id = ?').get(id)) continue;
      db.prepare(`
        INSERT INTO session_logs(
          id, profile_key, title, kind, host, started_at, ended_at, status,
          paused, capture_input, event_count, raw_bytes, normalized_bytes,
          current_part, current_part_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 1, 0)
      `).run(
        id,
        session.profile_key,
        session.title,
        session.kind,
        session.host,
        session.started_at,
        session.ended_at,
        session.status === 'active' ? 'disconnected' : session.status,
        session.capture_input,
      );
      const events = db.prepare(`
        SELECT part_number, sequence, recorded_at, elapsed_ms, direction,
               raw_data, normalized_text
        FROM legacy.session_log_events
        WHERE session_id = ? ORDER BY part_number, sequence
      `).all(id);
      let currentPart;
      let partial;
      let fd;
      let counters;
      const finishPart = () => {
        if (fd === undefined || partial === undefined || counters === undefined) return;
        fdatasyncSync(fd);
        closeSync(fd);
        const relative = finalizePartial(id, currentPart, partial);
        db.prepare(`
          INSERT INTO session_parts(
            session_id, part_number, filename, raw_bytes, stored_bytes,
            event_count, normalized_bytes, first_sequence, last_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          currentPart,
          relative,
          counters.rawBytes,
          statSync(path.join(root, relative)).size,
          counters.eventCount,
          counters.normalizedBytes,
          counters.firstSequence,
          counters.lastSequence,
        );
      };
      const insertChunk = db.prepare(`
        INSERT INTO transcript_chunks(
          session_id, part_number, first_sequence, last_sequence,
          recorded_at, elapsed_ms, direction, normalized_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        const part = Number(event.part_number);
        if (part !== currentPart) {
          finishPart();
          currentPart = part;
          const directory = sessionDirectory(id);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          partial = path.join(directory, `${partName(part)}.muxlog.partial`);
          fd = openSync(partial, 'w', 0o600);
          writeSync(fd, SEGMENT_HEADER);
          counters = {
            rawBytes: 0,
            normalizedBytes: 0,
            eventCount: 0,
            firstSequence: Number(event.sequence),
            lastSequence: Number(event.sequence),
          };
        }
        const raw = Buffer.from(event.raw_data);
        writeSync(fd, encodeFrame({
          sequence: Number(event.sequence),
          recordedAt: String(event.recorded_at),
          elapsedMs: Number(event.elapsed_ms),
          direction: String(event.direction),
        }, raw));
        const text = String(event.normalized_text);
        counters.rawBytes += raw.byteLength;
        counters.normalizedBytes += Buffer.byteLength(text, 'utf8');
        counters.eventCount += 1;
        counters.lastSequence = Number(event.sequence);
        if (text) {
          insertChunk.run(
            id,
            part,
            event.sequence,
            event.sequence,
            event.recorded_at,
            event.elapsed_ms,
            event.direction,
            text,
          );
        }
      }
      finishPart();
      const totals = db.prepare(`
        SELECT
          COALESCE(SUM(raw_bytes), 0) AS raw_bytes,
          COALESCE(SUM(normalized_bytes), 0) AS normalized_bytes,
          COALESCE(SUM(event_count), 0) AS event_count,
          COALESCE(MAX(part_number), 1) AS current_part
        FROM session_parts WHERE session_id = ?
      `).get(id);
      db.prepare(`
        UPDATE session_logs
        SET raw_bytes = ?, normalized_bytes = ?, event_count = ?,
            current_part = ?, current_part_bytes = 0
        WHERE id = ?
      `).run(
        totals.raw_bytes,
        totals.normalized_bytes,
        totals.event_count,
        totals.current_part,
        id,
      );
    }
  } finally {
    db.exec('DETACH DATABASE legacy');
  }
}

function summaryFromRow(row) {
  return {
    id: String(row.id),
    profileKey: String(row.profile_key),
    title: String(row.title),
    kind: String(row.kind),
    host: String(row.host),
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : undefined,
    status: String(row.status),
    paused: Number(row.paused) === 1,
    captureInput: Number(row.capture_input) === 1,
    pinned: Number(row.pinned) === 1,
    eventCount: Number(row.event_count),
    rawBytes: Number(row.raw_bytes),
    normalizedBytes: Number(row.normalized_bytes),
    partCount: Number(row.retained_part_count ?? 0),
    snippet: row.snippet ? String(row.snippet) : undefined,
    matchCount: row.match_count ? Number(row.match_count) : undefined,
  };
}

function removeTrash() {
  for (const entry of readdirSync(trashRoot)) {
    rmSync(path.join(trashRoot, entry), { recursive: true, force: true });
  }
}

function closeWorker() {
  if (closed) return;
  closed = true;
  clearInterval(maintenanceTimer);
  for (const id of writers.keys()) finalizeWriter(id);
  db.exec(`
    UPDATE session_logs
    SET status = 'disconnected',
        ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
        paused = 0,
        current_part_bytes = 0
    WHERE status = 'active';
    PRAGMA wal_checkpoint(TRUNCATE);
    PRAGMA optimize;
  `);
  db.close();
}

function safeSessionName(id) {
  return /^[A-Za-z0-9_-]+$/.test(id)
    ? id
    : Buffer.from(id, 'utf8').toString('base64url');
}

function sessionDirectory(id) {
  return path.join(sessionsRoot, safeSessionName(id));
}

function partName(part) {
  return String(part).padStart(6, '0');
}

function ftsExpression(value) {
  // Tokens without letters or digits tokenize to nothing in unicode61 and
  // would silently turn the whole AND-query into "match nothing".
  const tokens = value
    ?.trim()
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
  if (!tokens?.length) return undefined;
  return tokens
    .map((token, index) => {
      const phrase = `"${token.replaceAll('"', '""')}"`;
      // The final token is treated as a prefix so partially typed commands
      // and IPs ("192.168.7") already surface their sessions. Single-character
      // prefixes expand to a large slice of the token dictionary and cost
      // whole-corpus scans on a full database, so they match exactly instead.
      return index === tokens.length - 1 && token.length > 1 ? `${phrase}*` : phrase;
    })
    .join(' AND ');
}

function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function encodeCursor(startedAt, id) {
  return Buffer.from(JSON.stringify([startedAt, id]), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
      ? { startedAt: parsed[0], id: parsed[1] }
      : undefined;
  } catch {
    return undefined;
  }
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
