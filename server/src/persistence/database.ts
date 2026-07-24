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
  OpenSshMetadataPatch,
  TunnelInput,
  TunnelRecord,
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
] as const;

export interface OpenSshMetadata {
  profileId: string;
  favorite: boolean;
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
  /** Logical OS store adapter, for example "os-keychain". */
  provider: string;
  /** Stable application/service namespace in that store. */
  service: string;
  /** Account/key used to retrieve the secret from the OS store. */
  account: string;
  label?: string;
}

export interface CredentialRefRecord extends CredentialRefInput {
  id: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  layout: unknown;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export type WorkspaceSummary = Omit<WorkspaceRecord, 'layout'>;

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
      throw new Error(`${location}.${key} must be stored in the OS credential store, not the Muxus database`);
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
        profiles.favorite,
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
            favorite = ?,
            color = ?,
            icon = ?,
            keyword_highlights_json = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(
        displayName,
        groupId,
        patch.favorite === undefined ? Number(current.favorite) : patch.favorite ? 1 : 0,
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
   * Persist one complete visual group order. Profiles are created lazily so
   * even otherwise-unmodified OpenSSH hosts can participate in sorting.
   */
  reorderOpenSshHosts(aliases: readonly string[]): void {
    if (new Set(aliases).size !== aliases.length) throw new Error('host order contains duplicate aliases');
    for (const alias of aliases) requireNonEmpty(alias, 'alias');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(`
        UPDATE connection_profiles
        SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      aliases.forEach((alias, index) => {
        const profile = this.ensureOpenSshProfile(alias);
        update.run(index, String(profile.id));
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
    if (!previous) return;
    const next = this.metadataByAlias.get(nextAlias);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (next) {
        this.db
          .prepare(`
            UPDATE connection_profiles
            SET favorite = CASE WHEN favorite = 1 OR ? = 1 THEN 1 ELSE 0 END,
                connect_count = connect_count + ?,
                last_connected_at = CASE
                  WHEN last_connected_at IS NULL OR ? > last_connected_at THEN ?
                  ELSE last_connected_at
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .run(
            Number(next.favorite),
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

  saveWorkspace(input: { id?: string; name: string; layout: unknown }): WorkspaceRecord {
    requireNonEmpty(input.name, 'name');
    assertSecretFree(input.layout, 'workspace.layout');
    const id = input.id ?? nanoid();
    const layout = JSON.stringify(input.layout);
    if (layout === undefined) throw new Error('workspace.layout must be JSON-serializable');
    this.db
      .prepare(`
        INSERT INTO workspaces(id, name, layout_json)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          layout_json = excluded.layout_json,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(id, input.name.trim(), layout);
    return this.workspace(id)!;
  }

  workspace(id: string): WorkspaceRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT id, name, layout_json, created_at, updated_at, last_opened_at
        FROM workspaces WHERE id = ?
      `)
      .get(id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      name: String(row.name),
      layout: JSON.parse(String(row.layout_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastOpenedAt: optionalString(row.last_opened_at),
    };
  }

  latestWorkspace(): WorkspaceRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT id, name, layout_json, created_at, updated_at, last_opened_at
        FROM workspaces
        ORDER BY COALESCE(last_opened_at, updated_at) DESC, name COLLATE NOCASE
        LIMIT 1
      `)
      .get();
    if (!row) return undefined;
    return {
      id: String(row.id),
      name: String(row.name),
      layout: JSON.parse(String(row.layout_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastOpenedAt: optionalString(row.last_opened_at),
    };
  }

  listWorkspaceSummaries(): WorkspaceSummary[] {
    return this.db
      .prepare(`
        SELECT id, name, created_at, updated_at, last_opened_at
        FROM workspaces
        ORDER BY COALESCE(last_opened_at, updated_at) DESC, name COLLATE NOCASE
      `)
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        lastOpenedAt: optionalString(row.last_opened_at),
      }));
  }

  listWorkspaces(): WorkspaceRecord[] {
    return this.db
      .prepare(`
        SELECT id, name, layout_json, created_at, updated_at, last_opened_at
        FROM workspaces
        ORDER BY COALESCE(last_opened_at, updated_at) DESC, name COLLATE NOCASE
      `)
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        layout: JSON.parse(String(row.layout_json)),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        lastOpenedAt: optionalString(row.last_opened_at),
      }));
  }

  deleteWorkspace(id: string): boolean {
    return this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes > 0;
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
   *  silently create two visually indistinguishable sidebar groups. */
  private groupIdForName(name: string | null): string | null {
    const normalized = name?.trim();
    if (!normalized) return null;
    const existing = this.db
      .prepare('SELECT id FROM connection_groups WHERE name = ? COLLATE NOCASE ORDER BY created_at LIMIT 1')
      .get(normalized);
    if (existing) return String(existing.id);
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
    favorite: Number(row.favorite) === 1,
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
