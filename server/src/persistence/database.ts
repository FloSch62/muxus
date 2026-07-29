import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  DatabaseSync,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';
import { nanoid } from 'nanoid';
import type {
  ForwardType,
  HostKeywordHighlightConfig,
  ManagedHostRef,
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
  SessionHistorySettings,
  SessionHistorySettingsInput,
  SessionLoggingPolicy,
  SessionLoggingPolicyInput,
  TunnelInput,
  TunnelRecord,
  WorkspaceMultiExecGroup,
} from '@muxus/shared';

const MIGRATIONS = [
  {
    version: 1,
    name: 'foundation',
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
    name: 'tunnels',
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
    name: 'host-sort-order',
    sql: `
      ALTER TABLE connection_profiles ADD COLUMN sort_order INTEGER;
    `,
  },
  {
    version: 4,
    name: 'tunnel-ssh-options',
    sql: `
      ALTER TABLE tunnels
        ADD COLUMN ssh_options_json TEXT CHECK(ssh_options_json IS NULL OR json_valid(ssh_options_json));
    `,
  },
  {
    version: 5,
    name: 'host-keyword-highlights',
    sql: `
      ALTER TABLE connection_profiles
        ADD COLUMN keyword_highlights_json TEXT
        CHECK(keyword_highlights_json IS NULL OR json_valid(keyword_highlights_json));
    `,
  },
  {
    version: 6,
    name: 'persistent-session-history',
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
    name: 'bounded-session-history-settings',
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
    name: 'named-workspace-session-sets',
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
    name: 'drop-favorites',
    sql: `
      ALTER TABLE connection_profiles DROP COLUMN favorite;
    `,
  },
  {
    version: 10,
    name: 'terminal-scrollback-snapshots',
    sql: `
      CREATE TABLE terminal_snapshots (
        tab_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 11,
    name: 'version-terminal-scrollback-snapshots',
    sql: `
      ALTER TABLE terminal_snapshots
        ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1
        CHECK(format_version >= 1);
    `,
  },
  {
    version: 12,
    name: 'master-password-vault',
    sql: `
      CREATE TABLE password_vault (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        format_version INTEGER NOT NULL CHECK(format_version = 1),
        kdf_algorithm TEXT NOT NULL CHECK(kdf_algorithm = 'argon2id'),
        kdf_salt BLOB NOT NULL CHECK(length(kdf_salt) = 16),
        kdf_memory INTEGER NOT NULL CHECK(kdf_memory BETWEEN 8192 AND 1048576),
        kdf_passes INTEGER NOT NULL CHECK(kdf_passes BETWEEN 2 AND 10),
        kdf_parallelism INTEGER NOT NULL CHECK(kdf_parallelism BETWEEN 2 AND 16),
        wrapped_key_nonce BLOB NOT NULL CHECK(length(wrapped_key_nonce) = 12),
        wrapped_key_ciphertext BLOB NOT NULL CHECK(length(wrapped_key_ciphertext) = 32),
        wrapped_key_tag BLOB NOT NULL CHECK(length(wrapped_key_tag) = 16),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;

      CREATE TABLE credential_secrets (
        credential_ref_id TEXT PRIMARY KEY
          REFERENCES credential_refs(id) ON DELETE CASCADE,
        format_version INTEGER NOT NULL CHECK(format_version = 1),
        nonce BLOB NOT NULL CHECK(length(nonce) = 12),
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL CHECK(length(auth_tag) = 16),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `,
  },
  {
    version: 13,
    name: 'automatic-password-vault',
    sql: `
      DELETE FROM credential_refs
      WHERE provider = 'muxus-master-vault';

      DROP TABLE password_vault;

      CREATE TABLE password_vault (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        format_version INTEGER NOT NULL CHECK(format_version = 2),
        kdf_algorithm TEXT NOT NULL CHECK(kdf_algorithm = 'scrypt'),
        kdf_salt BLOB NOT NULL CHECK(length(kdf_salt) = 16),
        kdf_cost INTEGER NOT NULL CHECK(kdf_cost BETWEEN 1024 AND 1048576),
        kdf_block_size INTEGER NOT NULL CHECK(kdf_block_size BETWEEN 1 AND 32),
        kdf_parallelism INTEGER NOT NULL CHECK(kdf_parallelism BETWEEN 1 AND 16),
        master_key_nonce BLOB NOT NULL CHECK(length(master_key_nonce) = 12),
        master_key_ciphertext BLOB NOT NULL CHECK(length(master_key_ciphertext) = 32),
        master_key_tag BLOB NOT NULL CHECK(length(master_key_tag) = 16),
        device_key_nonce BLOB NOT NULL CHECK(length(device_key_nonce) = 12),
        device_key_ciphertext BLOB NOT NULL CHECK(length(device_key_ciphertext) = 32),
        device_key_tag BLOB NOT NULL CHECK(length(device_key_tag) = 16),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `,
  },
] as const;

const DEFAULT_SESSION_LOGGING_POLICY: SessionLoggingPolicyInput = {
  enabled: false,
  captureInput: false,
  maxPartBytes: 5 * 1024 * 1024,
  maxParts: 10,
};

export interface OpenSshMetadata {
  profileId: string;
  sortOrder?: number;
  displayName?: string;
  group?: string;
  color?: string;
  icon?: string;
  keywordHighlights?: HostKeywordHighlightConfig;
  lastConnectedAt?: string;
  connectCount: number;
}

export interface NativeConnectionInput {
  kind: 'ssh' | 'local' | 'serial' | 'telnet';
  name: string;
  config: Record<string, unknown>;
  credentialRefId?: string;
}

export interface CredentialRefInput {
  /** Logical credential provider, for example "muxus-master-vault". */
  provider: string;
  /** Stable application/service namespace in that provider. */
  service: string;
  /** Account/key used to retrieve the secret from the provider. */
  account: string;
  label?: string;
}

export interface CredentialRefRecord extends CredentialRefInput {
  id: string;
}

export interface PasswordVaultConfigInput {
  formatVersion: 2;
  kdfAlgorithm: 'scrypt';
  kdfSalt: Buffer;
  kdfCost: number;
  kdfBlockSize: number;
  kdfParallelism: number;
  masterKeyNonce: Buffer;
  masterKeyCiphertext: Buffer;
  masterKeyTag: Buffer;
  deviceKeyNonce: Buffer;
  deviceKeyCiphertext: Buffer;
  deviceKeyTag: Buffer;
}

export interface PasswordVaultConfigRecord extends PasswordVaultConfigInput {
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedCredentialInput extends CredentialRefInput {
  formatVersion: 1;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export interface EncryptedCredentialRecord extends EncryptedCredentialInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  layout: unknown;
  multiExecGroups: WorkspaceMultiExecGroup[];
  isStartup: boolean;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export type WorkspaceSummary = Omit<WorkspaceRecord, 'layout' | 'multiExecGroups'>;

export interface TerminalSnapshotRecord {
  tabId: string;
  data: string;
  formatVersion: number;
  updatedAt: string;
}

export interface SessionLogCreateInput {
  profileKey: string;
  title: string;
  kind: 'ssh' | 'local' | 'serial' | 'telnet';
  host: string;
  startedAt: string;
  captureInput: boolean;
}

/**
 * Reject secrets at the persistence boundary. Profiles may contain key paths
 * and credential-reference IDs, but never passwords, passphrases, tokens, or
 * private-key material.
 */
export function assertSecretFree(value: unknown, location = 'config'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const words = key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^a-z0-9]+/i)
      .filter(Boolean)
      .map((word) => word.toLowerCase());
    const sensitive =
      words.some((word) =>
        word === 'password' ||
        word === 'passphrase' ||
        word === 'secret' ||
        word === 'token' ||
        word === 'privatekey'
      ) ||
      words.some((word, index) => word === 'private' && words[index + 1] === 'key');
    const referenceOnly =
      ['path', 'file', 'filename', 'ref', 'reference', 'id'].includes(words.at(-1) ?? '');
    if (sensitive && !referenceOnly) {
      throw new Error(
        `${location}.${key} must not be stored in profile or workspace data; use the encrypted password vault`,
      );
    }
    assertSecretFree(child, `${location}.${key}`);
  }
}

export class MuxusDatabase {
  private readonly db: DatabaseSync;
  private readonly metadataByAlias: StatementSync;

  constructor(readonly filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') {
      try {
        chmodSync(filename, 0o600);
      } catch {
        /* permissions may be controlled by the platform/filesystem */
      }
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
    this.metadataByAlias = this.db.prepare(`
      SELECT
        profiles.id,
        profiles.name,
        profiles.ssh_alias,
        profiles.group_id,
        profiles.sort_order,
        profiles.color,
        profiles.icon,
        profiles.keyword_highlights_json,
        profiles.last_connected_at,
        profiles.connect_count,
        groups.name AS group_name
      FROM connection_profiles AS profiles
      LEFT JOIN connection_groups AS groups ON groups.id = profiles.group_id
      WHERE profiles.kind = 'openssh' AND profiles.ssh_alias = ?
    `);
  }

  close(): void {
    this.db.close();
  }

  appliedMigrations(): Array<{ version: number; name: string }> {
    return this.db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => ({ version: Number(row.version), name: String(row.name) }));
  }

  openSshMetadata(aliases: readonly string[]): Map<string, OpenSshMetadata> {
    const result = new Map<string, OpenSshMetadata>();
    for (const alias of aliases) {
      const row = this.metadataByAlias.get(alias);
      if (!row) continue;
      result.set(alias, metadataFromRow(row));
    }
    return result;
  }

  updateOpenSshMetadata(
    alias: string,
    patch: OpenSshMetadataPatch,
  ): OpenSshMetadata {
    requireNonEmpty(alias, 'alias');
    const current = this.ensureOpenSshProfile(alias);
    const displayName =
      patch.displayName === undefined ? String(current.name) : patch.displayName?.trim() || alias;
    const groupId =
      patch.group === undefined ? nullableString(current.group_id) : this.groupIdForName(patch.group);
    this.db
      .prepare(`
        UPDATE connection_profiles
        SET name = ?,
            group_id = ?,
            color = ?,
            icon = ?,
            keyword_highlights_json = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(
        displayName,
        groupId,
        patch.color === undefined ? nullableString(current.color) : patch.color,
        patch.icon === undefined ? nullableString(current.icon) : patch.icon,
        patch.keywordHighlights === undefined
          ? nullableString(current.keyword_highlights_json)
          : patch.keywordHighlights === null
            ? null
            : JSON.stringify(patch.keywordHighlights),
        String(current.id),
      );
    return metadataFromRow(this.metadataByAlias.get(alias)!);
  }

  /**
   * Persist one complete visual group order across both host sources. Rows
   * for OpenSSH hosts are created lazily so even otherwise-unmodified hosts
   * can participate in sorting; saved Telnet/serial hosts must already exist.
   */
  reorderManagedHosts(refs: readonly ManagedHostRef[]): void {
    const keys = refs.map((ref) => (ref.kind === 'ssh' ? `ssh:${ref.alias}` : `profile:${ref.id}`));
    if (new Set(keys).size !== keys.length) throw new Error('host order contains duplicates');
    for (const ref of refs) {
      requireNonEmpty(ref.kind === 'ssh' ? ref.alias : ref.id, ref.kind === 'ssh' ? 'alias' : 'id');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const savedExists = this.db.prepare(
        `SELECT id FROM connection_profiles WHERE id = ? AND kind IN ('serial', 'telnet')`,
      );
      const update = this.db.prepare(`
        UPDATE connection_profiles
        SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      refs.forEach((ref, index) => {
        if (ref.kind === 'profile' && !savedExists.get(ref.id)) throw new Error('saved host not found');
        const id = ref.kind === 'ssh' ? String(this.ensureOpenSshProfile(ref.alias).id) : ref.id;
        update.run(index, id);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  recordOpenSshConnection(alias: string): OpenSshMetadata {
    requireNonEmpty(alias, 'alias');
    const current = this.ensureOpenSshProfile(alias);
    this.db
      .prepare(`
        UPDATE connection_profiles
        SET last_connected_at = CURRENT_TIMESTAMP,
            connect_count = connect_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(String(current.id));
    return metadataFromRow(this.metadataByAlias.get(alias)!);
  }

  /** Preserve the stable profile ID when a Host alias is renamed externally. */
  renameOpenSshAlias(previousAlias: string, nextAlias: string): void {
    if (previousAlias === nextAlias) return;
    requireNonEmpty(previousAlias, 'previousAlias');
    requireNonEmpty(nextAlias, 'nextAlias');
    const previous = this.metadataByAlias.get(previousAlias);
    const next = this.metadataByAlias.get(nextAlias);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.moveSessionLoggingPolicy(`ssh:${previousAlias}`, `ssh:${nextAlias}`);
      if (!previous) {
        this.db.exec('COMMIT');
        return;
      }
      if (next) {
        this.db
          .prepare(`
            UPDATE connection_profiles
            SET connect_count = connect_count + ?,
                last_connected_at = CASE
                  WHEN last_connected_at IS NULL OR ? > last_connected_at THEN ?
                  ELSE last_connected_at
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .run(
            Number(next.connect_count),
            optionalString(next.last_connected_at) ?? '',
            nullableString(next.last_connected_at),
            String(previous.id),
          );
        this.db.prepare('DELETE FROM connection_profiles WHERE id = ?').run(String(next.id));
      }
      const oldNameWasAlias = String(previous.name) === previousAlias;
      this.db
        .prepare(`
          UPDATE connection_profiles
          SET ssh_alias = ?, name = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(nextAlias, oldNameWasAlias ? nextAlias : String(previous.name), String(previous.id));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  upsertCredentialRef(input: CredentialRefInput): CredentialRefRecord {
    requireNonEmpty(input.provider, 'provider');
    requireNonEmpty(input.service, 'service');
    requireNonEmpty(input.account, 'account');
    const existing = this.db
      .prepare(`
        SELECT id FROM credential_refs
        WHERE provider = ? AND service = ? AND account = ?
      `)
      .get(input.provider, input.service, input.account);
    const id = existing ? String(existing.id) : nanoid();
    this.db
      .prepare(`
        INSERT INTO credential_refs(id, provider, service, account, label)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, service, account) DO UPDATE SET
          label = excluded.label,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(id, input.provider, input.service, input.account, input.label?.trim() || null);
    return { id, ...input, label: input.label?.trim() || undefined };
  }

  passwordVaultConfig(): PasswordVaultConfigRecord | undefined {
    const row = this.db.prepare('SELECT * FROM password_vault WHERE singleton = 1').get();
    if (!row) return undefined;
    return passwordVaultConfigFromRow(row);
  }

  createPasswordVaultConfig(input: PasswordVaultConfigInput): void {
    this.db
      .prepare(`
        INSERT INTO password_vault(
          singleton, format_version, kdf_algorithm, kdf_salt, kdf_cost,
          kdf_block_size, kdf_parallelism, master_key_nonce,
          master_key_ciphertext, master_key_tag, device_key_nonce,
          device_key_ciphertext, device_key_tag
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.formatVersion,
        input.kdfAlgorithm,
        input.kdfSalt,
        input.kdfCost,
        input.kdfBlockSize,
        input.kdfParallelism,
        input.masterKeyNonce,
        input.masterKeyCiphertext,
        input.masterKeyTag,
        input.deviceKeyNonce,
        input.deviceKeyCiphertext,
        input.deviceKeyTag,
      );
  }

  updatePasswordVaultConfig(input: PasswordVaultConfigInput): void {
    const changed = this.db
      .prepare(`
        UPDATE password_vault
        SET format_version = ?, kdf_algorithm = ?, kdf_salt = ?,
            kdf_cost = ?, kdf_block_size = ?, kdf_parallelism = ?,
            master_key_nonce = ?, master_key_ciphertext = ?,
            master_key_tag = ?, device_key_nonce = ?,
            device_key_ciphertext = ?, device_key_tag = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE singleton = 1
      `)
      .run(
        input.formatVersion,
        input.kdfAlgorithm,
        input.kdfSalt,
        input.kdfCost,
        input.kdfBlockSize,
        input.kdfParallelism,
        input.masterKeyNonce,
        input.masterKeyCiphertext,
        input.masterKeyTag,
        input.deviceKeyNonce,
        input.deviceKeyCiphertext,
        input.deviceKeyTag,
      );
    if (Number(changed.changes) !== 1) throw new Error('password vault is not configured');
  }

  encryptedCredential(
    provider: string,
    service: string,
    account: string,
  ): EncryptedCredentialRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT refs.id, refs.provider, refs.service, refs.account, refs.label,
               refs.created_at, secrets.updated_at, secrets.format_version,
               secrets.nonce, secrets.ciphertext, secrets.auth_tag
        FROM credential_refs AS refs
        JOIN credential_secrets AS secrets ON secrets.credential_ref_id = refs.id
        WHERE refs.provider = ? AND refs.service = ? AND refs.account = ?
      `)
      .get(provider, service, account);
    return row ? encryptedCredentialFromRow(row) : undefined;
  }

  encryptedCredentialById(
    id: string,
    provider: string,
  ): EncryptedCredentialRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT refs.id, refs.provider, refs.service, refs.account, refs.label,
               refs.created_at, secrets.updated_at, secrets.format_version,
               secrets.nonce, secrets.ciphertext, secrets.auth_tag
        FROM credential_refs AS refs
        JOIN credential_secrets AS secrets ON secrets.credential_ref_id = refs.id
        WHERE refs.id = ? AND refs.provider = ?
      `)
      .get(id, provider);
    return row ? encryptedCredentialFromRow(row) : undefined;
  }

  listEncryptedCredentials(provider: string, service: string): EncryptedCredentialRecord[] {
    return this.db
      .prepare(`
        SELECT refs.id, refs.provider, refs.service, refs.account, refs.label,
               refs.created_at, secrets.updated_at, secrets.format_version,
               secrets.nonce, secrets.ciphertext, secrets.auth_tag
        FROM credential_refs AS refs
        JOIN credential_secrets AS secrets ON secrets.credential_ref_id = refs.id
        WHERE refs.provider = ? AND refs.service = ?
        ORDER BY refs.label COLLATE NOCASE, refs.account
      `)
      .all(provider, service)
      .map(encryptedCredentialFromRow);
  }

  upsertEncryptedCredential(input: EncryptedCredentialInput): EncryptedCredentialRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ref = this.upsertCredentialRef(input);
      this.db
        .prepare(`
          INSERT INTO credential_secrets(
            credential_ref_id, format_version, nonce, ciphertext, auth_tag
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(credential_ref_id) DO UPDATE SET
            format_version = excluded.format_version,
            nonce = excluded.nonce,
            ciphertext = excluded.ciphertext,
            auth_tag = excluded.auth_tag,
            updated_at = CURRENT_TIMESTAMP
        `)
        .run(
          ref.id,
          input.formatVersion,
          input.nonce,
          input.ciphertext,
          input.authTag,
        );
      this.db.exec('COMMIT');
      return this.encryptedCredential(input.provider, input.service, input.account)!;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deleteEncryptedCredential(id: string, provider: string): boolean {
    return (
      Number(
        this.db
          .prepare('DELETE FROM credential_refs WHERE id = ? AND provider = ?')
          .run(id, provider).changes,
      ) === 1
    );
  }

  deletePasswordVaultData(provider: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM credential_refs WHERE provider = ?').run(provider);
      this.db.prepare('DELETE FROM password_vault WHERE singleton = 1').run();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  createNativeConnection(input: NativeConnectionInput): string {
    requireNonEmpty(input.name, 'name');
    assertSecretFree(input.config);
    const id = nanoid();
    this.db
      .prepare(`
        INSERT INTO connection_profiles(
          id, kind, name, native_config_json, credential_ref_id
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(id, input.kind, input.name.trim(), JSON.stringify(input.config), input.credentialRefId ?? null);
    return id;
  }

  listSavedHostProfiles(): SavedHostProfile[] {
    return this.db
      .prepare(`
        SELECT profiles.*, groups.name AS group_name
        FROM connection_profiles AS profiles
        LEFT JOIN connection_groups AS groups ON groups.id = profiles.group_id
        WHERE profiles.kind IN ('serial', 'telnet')
        ORDER BY profiles.sort_order, profiles.name COLLATE NOCASE
      `)
      .all()
      .map(savedHostFromRow);
  }

  saveSavedHostProfile(input: SavedHostProfileInput): SavedHostProfile {
    requireNonEmpty(input.name, 'name');
    const kind = input.profile.kind;
    const { kind: _kind, profileId: _profileId, ...config } = input.profile;
    assertSecretFree(config, 'profile.config');
    const id = input.id ?? nanoid();
    if (input.id) {
      const current = this.db
        .prepare(`SELECT kind FROM connection_profiles WHERE id = ? AND kind IN ('serial', 'telnet')`)
        .get(id);
      if (!current) throw new Error('saved host not found');
      this.db
        .prepare(`
          UPDATE connection_profiles
          SET kind = ?, name = ?, native_config_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(kind, input.name.trim(), JSON.stringify(config), id);
    } else {
      this.db
        .prepare(`
          INSERT INTO connection_profiles(id, kind, name, native_config_json)
          VALUES (?, ?, ?, ?)
        `)
        .run(id, kind, input.name.trim(), JSON.stringify(config));
    }
    return this.savedHostProfile(id)!;
  }

  savedHostProfile(id: string): SavedHostProfile | undefined {
    const row = this.db
      .prepare(`
        SELECT profiles.*, groups.name AS group_name
        FROM connection_profiles AS profiles
        LEFT JOIN connection_groups AS groups ON groups.id = profiles.group_id
        WHERE profiles.id = ? AND profiles.kind IN ('serial', 'telnet')
      `)
      .get(id);
    return row ? savedHostFromRow(row) : undefined;
  }

  updateSavedHostMetadata(id: string, patch: OpenSshMetadataPatch): SavedHostProfile {
    const current = this.db
      .prepare(`
        SELECT profiles.*, groups.name AS group_name
        FROM connection_profiles AS profiles
        LEFT JOIN connection_groups AS groups ON groups.id = profiles.group_id
        WHERE profiles.id = ? AND profiles.kind IN ('serial', 'telnet')
      `)
      .get(id);
    if (!current) throw new Error('saved host not found');
    const name =
      patch.displayName === undefined ? String(current.name) : patch.displayName?.trim() || String(current.name);
    const groupId =
      patch.group === undefined ? nullableString(current.group_id) : this.groupIdForName(patch.group);
    this.db
      .prepare(`
        UPDATE connection_profiles
        SET name = ?,
            group_id = ?,
            color = ?,
            icon = ?,
            keyword_highlights_json = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(
        name,
        groupId,
        patch.color === undefined ? nullableString(current.color) : patch.color,
        patch.icon === undefined ? nullableString(current.icon) : patch.icon,
        patch.keywordHighlights === undefined
          ? nullableString(current.keyword_highlights_json)
          : patch.keywordHighlights === null
            ? null
            : JSON.stringify(patch.keywordHighlights),
        id,
      );
    return this.savedHostProfile(id)!;
  }

  recordSavedHostConnection(id: string): void {
    this.db
      .prepare(`
        UPDATE connection_profiles
        SET last_connected_at = CURRENT_TIMESTAMP,
            connect_count = connect_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND kind IN ('serial', 'telnet')
      `)
      .run(id);
  }

  deleteSavedHostProfile(id: string): boolean {
    const deleted =
      this.db
        .prepare(`DELETE FROM connection_profiles WHERE id = ? AND kind IN ('serial', 'telnet')`)
        .run(id).changes > 0;
    if (deleted) {
      this.db
        .prepare('DELETE FROM session_logging_policies WHERE profile_key = ?')
        .run(`profile:${id}`);
    }
    return deleted;
  }

  saveWorkspace(input: {
    id?: string;
    name: string;
    layout: unknown;
    multiExecGroups?: WorkspaceMultiExecGroup[];
  }): WorkspaceRecord {
    requireNonEmpty(input.name, 'name');
    assertSecretFree(input.layout, 'workspace.layout');
    assertSecretFree(input.multiExecGroups, 'workspace.multiExecGroups');
    const id = input.id ?? nanoid();
    const layout = JSON.stringify(input.layout);
    const groups = JSON.stringify(input.multiExecGroups ?? []);
    if (layout === undefined) throw new Error('workspace.layout must be JSON-serializable');
    this.db
      .prepare(`
        INSERT INTO workspaces(id, name, layout_json, multi_exec_groups_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          layout_json = excluded.layout_json,
          multi_exec_groups_json = excluded.multi_exec_groups_json,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(id, input.name.trim(), layout, groups);
    return this.workspace(id)!;
  }

  workspace(id: string): WorkspaceRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT id, name, layout_json, multi_exec_groups_json, is_startup,
               created_at, updated_at, last_opened_at
        FROM workspaces WHERE id = ?
      `)
      .get(id);
    return row ? workspaceFromRow(row) : undefined;
  }

  latestWorkspace(): WorkspaceRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT id, name, layout_json, multi_exec_groups_json, is_startup,
               created_at, updated_at, last_opened_at
        FROM workspaces
        ORDER BY COALESCE(last_opened_at, updated_at) DESC, name COLLATE NOCASE
        LIMIT 1
      `)
      .get();
    return row ? workspaceFromRow(row) : undefined;
  }

  startupWorkspace(): WorkspaceRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT id, name, layout_json, multi_exec_groups_json, is_startup,
               created_at, updated_at, last_opened_at
        FROM workspaces
        WHERE is_startup = 1
        LIMIT 1
      `)
      .get();
    return row ? workspaceFromRow(row) : undefined;
  }

  listWorkspaceSummaries(): WorkspaceSummary[] {
    return this.db
      .prepare(`
        SELECT id, name, is_startup, created_at, updated_at, last_opened_at
        FROM workspaces
        ORDER BY COALESCE(last_opened_at, updated_at) DESC, name COLLATE NOCASE
      `)
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        isStartup: Number(row.is_startup) === 1,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        lastOpenedAt: optionalString(row.last_opened_at),
      }));
  }

  listWorkspaces(): WorkspaceRecord[] {
    return this.db
      .prepare(`
        SELECT id, name, layout_json, multi_exec_groups_json, is_startup,
               created_at, updated_at, last_opened_at
        FROM workspaces
        ORDER BY COALESCE(last_opened_at, updated_at) DESC, name COLLATE NOCASE
      `)
      .all()
      .map(workspaceFromRow);
  }

  renameWorkspace(id: string, name: string): WorkspaceRecord | undefined {
    requireNonEmpty(name, 'name');
    const updated = this.db
      .prepare(`
        UPDATE workspaces
        SET name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(name.trim(), id).changes > 0;
    return updated ? this.workspace(id) : undefined;
  }

  openWorkspace(id: string): WorkspaceRecord | undefined {
    const opened = this.db
      .prepare(`
        UPDATE workspaces
        SET last_opened_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(id).changes > 0;
    return opened ? this.workspace(id) : undefined;
  }

  setStartupWorkspace(id: string | null): WorkspaceRecord | undefined {
    if (id !== null && !this.workspace(id)) return undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE workspaces SET is_startup = 0 WHERE is_startup = 1').run();
      if (id !== null) {
        this.db.prepare('UPDATE workspaces SET is_startup = 1 WHERE id = ?').run(id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return id === null ? undefined : this.workspace(id);
  }

  deleteWorkspace(id: string): boolean {
    return this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes > 0;
  }

  saveTerminalSnapshot(tabId: string, data: string, formatVersion = 1): void {
    requireNonEmpty(tabId, 'tabId');
    this.db
      .prepare(`
        INSERT INTO terminal_snapshots(tab_id, data, format_version, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(tab_id) DO UPDATE SET
          data = excluded.data,
          format_version = excluded.format_version,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(tabId, data, formatVersion);
  }

  terminalSnapshot(tabId: string): TerminalSnapshotRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT tab_id, data, format_version, updated_at FROM terminal_snapshots WHERE tab_id = ?',
      )
      .get(tabId);
    if (!row) return undefined;
    return {
      tabId: String(row.tab_id),
      data: String(row.data),
      formatVersion: Number(row.format_version),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Drop snapshots for tabs no stored workspace references. Recent rows are
   * spared: a fresh tab's snapshot can land before its first layout autosave.
   */
  pruneTerminalSnapshots(graceSeconds = 3600): number {
    const referenced = new Set<string>();
    for (const workspace of this.listWorkspaces()) {
      const layout = workspace.layout as { root?: unknown } | null | undefined;
      collectLayoutTabIds(layout?.root, referenced);
    }
    const stale = this.db
      .prepare(`SELECT tab_id FROM terminal_snapshots WHERE updated_at <= datetime('now', ?)`)
      .all(`-${graceSeconds} seconds`);
    let pruned = 0;
    for (const row of stale) {
      const tabId = String(row.tab_id);
      if (referenced.has(tabId)) continue;
      this.db.prepare('DELETE FROM terminal_snapshots WHERE tab_id = ?').run(tabId);
      pruned++;
    }
    return pruned;
  }

  listTunnels(): TunnelRecord[] {
    return this.db
      .prepare(`
        SELECT id, name, target, ssh_options_json, type, bind_port, target_host, target_port, created_at, updated_at
        FROM tunnels
        ORDER BY COALESCE(NULLIF(name, ''), target) COLLATE NOCASE, created_at
      `)
      .all()
      .map(tunnelFromRow);
  }

  saveTunnel(input: TunnelInput): TunnelRecord {
    requireNonEmpty(input.target, 'target');
    assertSecretFree(input.sshOptions, 'tunnel.sshOptions');
    const dynamic = input.type === 'dynamic';
    if (!dynamic && (!input.targetHost?.trim() || !input.targetPort)) {
      throw new Error('targetHost and targetPort are required for local/remote tunnels');
    }
    const id = input.id ?? nanoid();
    this.db
      .prepare(`
        INSERT INTO tunnels(id, name, target, ssh_options_json, type, bind_port, target_host, target_port)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          target = excluded.target,
          ssh_options_json = excluded.ssh_options_json,
          type = excluded.type,
          bind_port = excluded.bind_port,
          target_host = excluded.target_host,
          target_port = excluded.target_port,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        id,
        input.name?.trim() || null,
        input.target.trim(),
        input.sshOptions === undefined ? null : JSON.stringify(input.sshOptions),
        input.type,
        input.bindPort,
        dynamic ? null : input.targetHost!.trim(),
        dynamic ? null : input.targetPort!,
      );
    const row = this.db
      .prepare(`
        SELECT id, name, target, ssh_options_json, type, bind_port, target_host, target_port, created_at, updated_at
        FROM tunnels WHERE id = ?
      `)
      .get(id)!;
    return tunnelFromRow(row);
  }

  deleteTunnel(id: string): boolean {
    return this.db.prepare('DELETE FROM tunnels WHERE id = ?').run(id).changes > 0;
  }

  sessionLoggingPolicy(profileKey: string): SessionLoggingPolicy {
    requireNonEmpty(profileKey, 'profileKey');
    const exact = this.db
      .prepare(`
        SELECT enabled, capture_input, max_part_bytes, max_parts
        FROM session_logging_policies WHERE profile_key = ?
      `)
      .get(profileKey);
    const defaults =
      profileKey === '*'
        ? undefined
        : this.db
            .prepare(`
              SELECT enabled, capture_input, max_part_bytes, max_parts
              FROM session_logging_policies WHERE profile_key = '*'
            `)
            .get();
    const row = exact ?? defaults;
    return {
      profileKey,
      enabled: row ? Number(row.enabled) === 1 : DEFAULT_SESSION_LOGGING_POLICY.enabled,
      captureInput: row
        ? Number(row.capture_input) === 1
        : DEFAULT_SESSION_LOGGING_POLICY.captureInput,
      maxPartBytes: row
        ? Number(row.max_part_bytes)
        : DEFAULT_SESSION_LOGGING_POLICY.maxPartBytes,
      maxParts: row ? Number(row.max_parts) : DEFAULT_SESSION_LOGGING_POLICY.maxParts,
      overridden: !!exact,
    };
  }

  saveSessionLoggingPolicy(
    profileKey: string,
    input: SessionLoggingPolicyInput,
  ): SessionLoggingPolicy {
    requireNonEmpty(profileKey, 'profileKey');
    validateSessionLoggingPolicy(input);
    this.db
      .prepare(`
        INSERT INTO session_logging_policies(
          profile_key, enabled, capture_input, max_part_bytes, max_parts
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_key) DO UPDATE SET
          enabled = excluded.enabled,
          capture_input = excluded.capture_input,
          max_part_bytes = excluded.max_part_bytes,
          max_parts = excluded.max_parts,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        profileKey,
        input.enabled ? 1 : 0,
        input.captureInput ? 1 : 0,
        input.maxPartBytes,
        input.maxParts,
      );
    return this.sessionLoggingPolicy(profileKey);
  }

  deleteSessionLoggingPolicy(profileKey: string): boolean {
    requireNonEmpty(profileKey, 'profileKey');
    return (
      this.db
        .prepare('DELETE FROM session_logging_policies WHERE profile_key = ?')
        .run(profileKey).changes > 0
    );
  }

  sessionHistorySettings(): SessionHistorySettings {
    const row = this.db
      .prepare(`
        SELECT storage_location, max_total_bytes, min_free_bytes,
               min_free_percent, max_age_days
        FROM session_history_settings WHERE singleton = 1
      `)
      .get()!;
    return {
      storageLocation: optionalString(row.storage_location),
      maxTotalBytes: Number(row.max_total_bytes),
      minFreeBytes: Number(row.min_free_bytes),
      minFreePercent: Number(row.min_free_percent),
      maxAgeDays:
        row.max_age_days === null || row.max_age_days === undefined
          ? undefined
          : Number(row.max_age_days),
    };
  }

  saveSessionHistorySettings(
    input: SessionHistorySettingsInput,
  ): SessionHistorySettings {
    validateSessionHistorySettings(input);
    this.db
      .prepare(`
        UPDATE session_history_settings
        SET storage_location = ?,
            max_total_bytes = ?,
            min_free_bytes = ?,
            min_free_percent = ?,
            max_age_days = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE singleton = 1
      `)
      .run(
        input.storageLocation?.trim() || null,
        input.maxTotalBytes,
        input.minFreeBytes,
        input.minFreePercent,
        input.maxAgeDays ?? null,
      );
    return this.sessionHistorySettings();
  }

  /**
   * After the worker has imported version-6 history, remove every payload row
   * and history-only table from the application database. A one-time VACUUM
   * reclaims old BLOB pages when an upgrade actually imported payloads.
   */
  finalizeSessionHistorySeparation(compact: boolean): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS session_log_events_fts_insert;
      DROP TRIGGER IF EXISTS session_log_events_fts_delete;
      DROP TRIGGER IF EXISTS session_log_events_fts_update;
      DROP TABLE IF EXISTS session_log_events_fts;
      DROP TABLE IF EXISTS session_log_events;
      DROP TABLE IF EXISTS session_logs;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    if (compact) this.db.exec('VACUUM');
  }

  hasLegacySessionHistory(): boolean {
    const table = this.db
      .prepare(`
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'session_logs'
      `)
      .get();
    if (!table) return false;
    const row = this.db.prepare('SELECT 1 FROM session_logs LIMIT 1').get();
    return !!row;
  }

  private moveSessionLoggingPolicy(previousKey: string, nextKey: string): void {
    this.db
      .prepare(`
        INSERT INTO session_logging_policies(
          profile_key, enabled, capture_input, max_part_bytes, max_parts
        )
        SELECT ?, enabled, capture_input, max_part_bytes, max_parts
        FROM session_logging_policies
        WHERE profile_key = ?
        ON CONFLICT(profile_key) DO UPDATE SET
          enabled = excluded.enabled,
          capture_input = excluded.capture_input,
          max_part_bytes = excluded.max_part_bytes,
          max_parts = excluded.max_parts,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(nextKey, previousKey);
    this.db
      .prepare('DELETE FROM session_logging_policies WHERE profile_key = ?')
      .run(previousKey);
  }

  private ensureOpenSshProfile(alias: string): SqlRow {
    const existing = this.metadataByAlias.get(alias);
    if (existing) return existing;
    const id = nanoid();
    this.db
      .prepare(`
        INSERT INTO connection_profiles(id, kind, name, ssh_alias)
        VALUES (?, 'openssh', ?, ?)
      `)
      .run(id, alias, alias);
    return this.metadataByAlias.get(alias)!;
  }

  /** Reuse group names case-insensitively so typing "work" and "Work" cannot
   *  silently create two visually indistinguishable sidebar groups. A spelling
   *  that differs only by case updates the row instead of being discarded, so
   *  renaming a folder to fix its capitalization actually takes effect. */
  private groupIdForName(name: string | null): string | null {
    const normalized = name?.trim();
    if (!normalized) return null;
    const existing = this.db
      .prepare('SELECT id, name FROM connection_groups WHERE name = ? COLLATE NOCASE ORDER BY created_at LIMIT 1')
      .get(normalized);
    if (existing) {
      if (String(existing.name) !== normalized) {
        this.db
          .prepare('UPDATE connection_groups SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(normalized, String(existing.id));
      }
      return String(existing.id);
    }
    const id = nanoid();
    this.db
      .prepare('INSERT INTO connection_groups(id, name) VALUES (?, ?)')
      .run(id, normalized);
    return id;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `);
    const applied = new Set(
      this.db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => Number(row.version)),
    );
    const newest = Math.max(0, ...applied);
    const supported = MIGRATIONS.at(-1)?.version ?? 0;
    if (newest > supported) {
      throw new Error(`database schema ${newest} is newer than this Muxus build supports (${supported})`);
    }
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations(version, name) VALUES (?, ?)')
          .run(migration.version, migration.name);
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }
}

type SqlRow = Record<string, SQLOutputValue>;

function blob(row: SqlRow, key: string): Buffer {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new Error(`invalid database blob: ${key}`);
  return Buffer.from(value);
}

function passwordVaultConfigFromRow(row: SqlRow): PasswordVaultConfigRecord {
  return {
    formatVersion: Number(row.format_version) as 2,
    kdfAlgorithm: String(row.kdf_algorithm) as 'scrypt',
    kdfSalt: blob(row, 'kdf_salt'),
    kdfCost: Number(row.kdf_cost),
    kdfBlockSize: Number(row.kdf_block_size),
    kdfParallelism: Number(row.kdf_parallelism),
    masterKeyNonce: blob(row, 'master_key_nonce'),
    masterKeyCiphertext: blob(row, 'master_key_ciphertext'),
    masterKeyTag: blob(row, 'master_key_tag'),
    deviceKeyNonce: blob(row, 'device_key_nonce'),
    deviceKeyCiphertext: blob(row, 'device_key_ciphertext'),
    deviceKeyTag: blob(row, 'device_key_tag'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function encryptedCredentialFromRow(row: SqlRow): EncryptedCredentialRecord {
  return {
    id: String(row.id),
    provider: String(row.provider),
    service: String(row.service),
    account: String(row.account),
    label: nullableString(row.label) ?? undefined,
    formatVersion: Number(row.format_version) as 1,
    nonce: blob(row, 'nonce'),
    ciphertext: blob(row, 'ciphertext'),
    authTag: blob(row, 'auth_tag'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Walk a stored layout tree defensively — its shape is `unknown` in the DB. */
function collectLayoutTabIds(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const record = node as { type?: unknown; children?: unknown; tabs?: unknown };
  if (record.type === 'split' && Array.isArray(record.children)) {
    for (const child of record.children) collectLayoutTabIds(child, into);
    return;
  }
  if (!Array.isArray(record.tabs)) return;
  for (const tab of record.tabs) {
    if (tab && typeof tab === 'object' && typeof (tab as { id?: unknown }).id === 'string') {
      into.add((tab as { id: string }).id);
    }
  }
}

function workspaceFromRow(row: SqlRow): WorkspaceRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    layout: JSON.parse(String(row.layout_json)),
    multiExecGroups: JSON.parse(String(row.multi_exec_groups_json)) as WorkspaceMultiExecGroup[],
    isStartup: Number(row.is_startup) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastOpenedAt: optionalString(row.last_opened_at),
  };
}

function tunnelFromRow(row: SqlRow): TunnelRecord {
  const type = String(row.type) as ForwardType;
  const sshOptions =
    typeof row.ssh_options_json === 'string'
      ? (JSON.parse(row.ssh_options_json) as TunnelRecord['sshOptions'])
      : undefined;
  return {
    id: String(row.id),
    name: optionalString(row.name),
    target: String(row.target),
    sshOptions,
    type,
    bindPort: Number(row.bind_port),
    targetHost: type === 'dynamic' ? undefined : String(row.target_host),
    targetPort: type === 'dynamic' ? undefined : Number(row.target_port),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function metadataFromRow(row: SqlRow): OpenSshMetadata {
  const alias = String(row.ssh_alias);
  const name = String(row.name);
  return {
    profileId: String(row.id),
    sortOrder: row.sort_order === null || row.sort_order === undefined ? undefined : Number(row.sort_order),
    displayName: name === alias ? undefined : name,
    group: optionalString(row.group_name),
    color: optionalString(row.color),
    icon: optionalString(row.icon),
    keywordHighlights: keywordHighlightsFromJson(row.keyword_highlights_json),
    lastConnectedAt: optionalString(row.last_connected_at),
    connectCount: Number(row.connect_count),
  };
}

function savedHostFromRow(row: SqlRow): SavedHostProfile {
  const id = String(row.id);
  const kind = String(row.kind) as SavedHostProfile['kind'];
  const config = JSON.parse(String(row.native_config_json)) as Record<string, unknown>;
  return {
    id,
    kind,
    name: String(row.name),
    profile: { kind, ...config, profileId: id } as SavedHostProfile['profile'],
    metadata: {
      profileId: id,
      sortOrder: row.sort_order === null || row.sort_order === undefined ? undefined : Number(row.sort_order),
      group: optionalString(row.group_name),
      color: optionalString(row.color),
      icon: optionalString(row.icon),
      keywordHighlights: keywordHighlightsFromJson(row.keyword_highlights_json),
      lastConnectedAt: optionalString(row.last_connected_at),
      connectCount: Number(row.connect_count),
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function keywordHighlightsFromJson(value: unknown): HostKeywordHighlightConfig | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<HostKeywordHighlightConfig>;
    if (typeof parsed.inheritGlobal !== 'boolean' || !Array.isArray(parsed.rules)) return undefined;
    return parsed as HostKeywordHighlightConfig;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requireNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`);
}

function validateSessionLoggingPolicy(input: SessionLoggingPolicyInput): void {
  if (
    !Number.isInteger(input.maxPartBytes) ||
    input.maxPartBytes < 64 * 1024 ||
    input.maxPartBytes > 1024 * 1024 * 1024
  ) {
    throw new Error('maxPartBytes must be between 64 KiB and 1 GiB');
  }
  if (!Number.isInteger(input.maxParts) || input.maxParts < 1 || input.maxParts > 1000) {
    throw new Error('maxParts must be between 1 and 1000');
  }
}

function validateSessionHistorySettings(input: SessionHistorySettingsInput): void {
  if (input.storageLocation) {
    const location = path.resolve(input.storageLocation);
    if (!path.isAbsolute(input.storageLocation)) {
      throw new Error('storageLocation must be an absolute path');
    }
    if (path.parse(location).root === location) {
      throw new Error('storageLocation cannot be the filesystem root');
    }
  }
  if (
    !Number.isSafeInteger(input.maxTotalBytes) ||
    input.maxTotalBytes < 64 * 1024 * 1024
  ) {
    throw new Error('maxTotalBytes must be at least 64 MiB');
  }
  if (!Number.isSafeInteger(input.minFreeBytes) || input.minFreeBytes < 0) {
    throw new Error('minFreeBytes must be a non-negative integer');
  }
  if (
    !Number.isFinite(input.minFreePercent) ||
    input.minFreePercent < 0 ||
    input.minFreePercent > 100
  ) {
    throw new Error('minFreePercent must be between 0 and 100');
  }
  if (
    input.maxAgeDays !== undefined &&
    (!Number.isInteger(input.maxAgeDays) || input.maxAgeDays < 1)
  ) {
    throw new Error('maxAgeDays must be a positive integer when enabled');
  }
}
