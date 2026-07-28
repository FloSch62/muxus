package persist

import "fmt"

// Migration is one applied schema_migrations row.
type Migration struct {
	Version int    `json:"version"`
	Name    string `json:"name"`
}

// migrations must stay byte-for-byte compatible with the MIGRATIONS list in
// database.ts: both implementations replay the same history against the same
// schema_migrations table.
var migrations = []struct {
	version int
	name    string
	sql     string
}{
	{
		version: 1,
		name:    "foundation",
		sql: `
      CREATE TABLE credential_refs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        service TEXT NOT NULL,
        account TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, service, account)
      ) STRICT;

      CREATE TABLE connection_groups (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES connection_groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;

      CREATE TABLE connection_profiles (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('openssh', 'ssh', 'local', 'serial', 'telnet')),
        name TEXT NOT NULL,
        ssh_alias TEXT UNIQUE,
        native_config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(native_config_json)),
        credential_ref_id TEXT REFERENCES credential_refs(id) ON DELETE SET NULL,
        group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
        favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
        color TEXT,
        icon TEXT,
        last_connected_at TEXT,
        connect_count INTEGER NOT NULL DEFAULT 0 CHECK(connect_count >= 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(
          (kind = 'openssh' AND ssh_alias IS NOT NULL AND native_config_json = '{}')
          OR (kind <> 'openssh' AND ssh_alias IS NULL)
        )
      ) STRICT;

      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        color TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;

      CREATE TABLE connection_tags (
        connection_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY(connection_id, tag_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        layout_json TEXT NOT NULL CHECK(json_valid(layout_json)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_opened_at TEXT
      ) STRICT;

      CREATE INDEX connection_profiles_recent
        ON connection_profiles(last_connected_at DESC)
        WHERE last_connected_at IS NOT NULL;
      CREATE INDEX connection_profiles_group
        ON connection_profiles(group_id, name COLLATE NOCASE);
    `,
	},
	{
		version: 2,
		name:    "tunnels",
		sql: `
      CREATE TABLE tunnels (
        id TEXT PRIMARY KEY,
        name TEXT,
        target TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('local', 'remote', 'dynamic')),
        bind_port INTEGER NOT NULL CHECK(bind_port BETWEEN 1 AND 65535),
        target_host TEXT,
        target_port INTEGER CHECK(target_port BETWEEN 1 AND 65535),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(
          (type = 'dynamic' AND target_host IS NULL AND target_port IS NULL)
          OR (type <> 'dynamic' AND target_host IS NOT NULL AND target_port IS NOT NULL)
        )
      ) STRICT;
    `,
	},
	{
		version: 3,
		name:    "host-sort-order",
		sql: `
      ALTER TABLE connection_profiles ADD COLUMN sort_order INTEGER;
    `,
	},
	{
		version: 4,
		name:    "tunnel-ssh-options",
		sql: `
      ALTER TABLE tunnels
        ADD COLUMN ssh_options_json TEXT CHECK(ssh_options_json IS NULL OR json_valid(ssh_options_json));
    `,
	},
	{
		version: 5,
		name:    "host-keyword-highlights",
		sql: `
      ALTER TABLE connection_profiles
        ADD COLUMN keyword_highlights_json TEXT
        CHECK(keyword_highlights_json IS NULL OR json_valid(keyword_highlights_json));
    `,
	},
	{
		version: 6,
		name:    "persistent-session-history",
		sql: `
      CREATE TABLE session_logging_policies (
        profile_key TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        capture_input INTEGER NOT NULL CHECK(capture_input IN (0, 1)),
        max_part_bytes INTEGER NOT NULL CHECK(max_part_bytes BETWEEN 65536 AND 1073741824),
        max_parts INTEGER NOT NULL CHECK(max_parts BETWEEN 1 AND 1000),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;

      CREATE TABLE session_logs (
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
        event_count INTEGER NOT NULL DEFAULT 0 CHECK(event_count >= 0),
        raw_bytes INTEGER NOT NULL DEFAULT 0 CHECK(raw_bytes >= 0),
        normalized_bytes INTEGER NOT NULL DEFAULT 0 CHECK(normalized_bytes >= 0),
        current_part INTEGER NOT NULL DEFAULT 1 CHECK(current_part >= 1),
        current_part_bytes INTEGER NOT NULL DEFAULT 0 CHECK(current_part_bytes >= 0)
      ) STRICT;

      CREATE TABLE session_log_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES session_logs(id) ON DELETE CASCADE,
        part_number INTEGER NOT NULL CHECK(part_number >= 1),
        sequence INTEGER NOT NULL CHECK(sequence >= 1),
        recorded_at TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
        direction TEXT NOT NULL CHECK(direction IN ('input', 'output', 'system')),
        raw_data BLOB NOT NULL,
        normalized_text TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      ) STRICT;

      CREATE INDEX session_logs_started ON session_logs(started_at DESC);
      CREATE INDEX session_logs_profile_started ON session_logs(profile_key, started_at DESC);
      CREATE INDEX session_log_events_session_sequence
        ON session_log_events(session_id, sequence);
      CREATE INDEX session_log_events_session_part
        ON session_log_events(session_id, part_number);

      CREATE VIRTUAL TABLE session_log_events_fts USING fts5(
        normalized_text,
        content = 'session_log_events',
        content_rowid = 'id',
        tokenize = 'unicode61'
      );

      CREATE TRIGGER session_log_events_fts_insert AFTER INSERT ON session_log_events BEGIN
        INSERT INTO session_log_events_fts(rowid, normalized_text)
        VALUES (new.id, new.normalized_text);
      END;
      CREATE TRIGGER session_log_events_fts_delete AFTER DELETE ON session_log_events BEGIN
        INSERT INTO session_log_events_fts(session_log_events_fts, rowid, normalized_text)
        VALUES ('delete', old.id, old.normalized_text);
      END;
      CREATE TRIGGER session_log_events_fts_update AFTER UPDATE ON session_log_events BEGIN
        INSERT INTO session_log_events_fts(session_log_events_fts, rowid, normalized_text)
        VALUES ('delete', old.id, old.normalized_text);
        INSERT INTO session_log_events_fts(rowid, normalized_text)
        VALUES (new.id, new.normalized_text);
      END;
    `,
	},
	{
		version: 7,
		name:    "bounded-session-history-settings",
		sql: `
      CREATE TABLE session_history_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        storage_location TEXT,
        max_total_bytes INTEGER NOT NULL CHECK(max_total_bytes >= 67108864),
        min_free_bytes INTEGER NOT NULL CHECK(min_free_bytes >= 0),
        min_free_percent REAL NOT NULL CHECK(min_free_percent BETWEEN 0 AND 100),
        max_age_days INTEGER CHECK(max_age_days IS NULL OR max_age_days >= 1),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;

      INSERT INTO session_history_settings(
        singleton, storage_location, max_total_bytes, min_free_bytes,
        min_free_percent, max_age_days
      ) VALUES (1, NULL, 5368709120, 2147483648, 5, NULL);
    `,
	},
	{
		version: 8,
		name:    "named-workspace-session-sets",
		sql: `
      ALTER TABLE workspaces
        ADD COLUMN multi_exec_groups_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(multi_exec_groups_json));
      ALTER TABLE workspaces
        ADD COLUMN is_startup INTEGER NOT NULL DEFAULT 0
        CHECK(is_startup IN (0, 1));
      CREATE UNIQUE INDEX workspaces_single_startup
        ON workspaces(is_startup)
        WHERE is_startup = 1;
    `,
	},
	{
		version: 9,
		name:    "drop-favorites",
		sql: `
      ALTER TABLE connection_profiles DROP COLUMN favorite;
    `,
	},
	{
		version: 10,
		name:    "terminal-scrollback-snapshots",
		sql: `
      CREATE TABLE terminal_snapshots (
        tab_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
	},
}

func (d *DB) migrate() error {
	if _, err := d.db.Exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `); err != nil {
		return err
	}
	rows, err := d.db.Query("SELECT version FROM schema_migrations")
	if err != nil {
		return err
	}
	applied := make(map[int]bool)
	newest := 0
	for rows.Next() {
		var version int
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			return err
		}
		applied[version] = true
		if version > newest {
			newest = version
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	supported := migrations[len(migrations)-1].version
	if newest > supported {
		return fmt.Errorf("database schema %d is newer than this Muxus build supports (%d)", newest, supported)
	}
	for _, migration := range migrations {
		if applied[migration.version] {
			continue
		}
		tx, err := d.begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migration.sql); err != nil {
			tx.Rollback()
			return err
		}
		if _, err := tx.Exec(
			"INSERT INTO schema_migrations(version, name) VALUES (?, ?)",
			migration.version, migration.name,
		); err != nil {
			tx.Rollback()
			return err
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", migration.version)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// AppliedMigrations lists the schema_migrations rows in version order.
func (d *DB) AppliedMigrations() ([]Migration, error) {
	rows, err := d.db.Query("SELECT version, name FROM schema_migrations ORDER BY version")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Migration
	for rows.Next() {
		var m Migration
		if err := rows.Scan(&m.Version, &m.Name); err != nil {
			return nil, err
		}
		result = append(result, m)
	}
	return result, rows.Err()
}
