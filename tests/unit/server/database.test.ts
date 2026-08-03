import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MuxusDatabase,
  WorkspaceLockedError,
  assertSecretFree,
} from '../../../server/src/persistence/database.js';

let database: MuxusDatabase | undefined;
let temporaryDirectory: string | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe('MuxusDatabase migrations', () => {
  it('applies the versioned schema', () => {
    database = new MuxusDatabase(':memory:');
    expect(database.appliedMigrations()).toEqual([
      { version: 1, name: 'foundation' },
      { version: 2, name: 'tunnels' },
      { version: 3, name: 'host-sort-order' },
      { version: 4, name: 'tunnel-ssh-options' },
      { version: 5, name: 'host-keyword-highlights' },
      { version: 6, name: 'persistent-session-history' },
      { version: 7, name: 'bounded-session-history-settings' },
      { version: 8, name: 'named-workspace-session-sets' },
      { version: 9, name: 'drop-favorites' },
      { version: 10, name: 'terminal-scrollback-snapshots' },
      { version: 11, name: 'version-terminal-scrollback-snapshots' },
      { version: 12, name: 'password-vault' },
      { version: 13, name: 'automatic-password-vault' },
      { version: 14, name: 'password-vault-os-keystore' },
      { version: 15, name: 'password-vault-key-check' },
      { version: 16, name: 'password-vault-key-cleanup' },
      { version: 17, name: 'folder-settings' },
      { version: 18, name: 'lock-workspaces' },
    ]);
  });

  it('upgrades the draft version 13 vault without deleting credentials', () => {
    temporaryDirectory = mkdtempSync(
      path.join(os.tmpdir(), 'muxus-v13-migration-'),
    );
    const filename = path.join(temporaryDirectory, 'muxus.sqlite3');
    database = new MuxusDatabase(filename);
    database.upsertEncryptedCredential({
      provider: 'muxus-master-vault',
      service: 'muxus/ssh-password/v1',
      account: 'legacy-account',
      label: 'legacy credential',
      formatVersion: 1,
      nonce: Buffer.alloc(12, 1),
      ciphertext: Buffer.from('legacy-ciphertext'),
      authTag: Buffer.alloc(16, 2),
    });
    database.close();
    database = undefined;

    const draft = new DatabaseSync(filename);
    try {
      draft.exec(`
        DELETE FROM schema_migrations WHERE version IN (13, 14, 15, 16);
        UPDATE schema_migrations
        SET name = 'master-password-vault'
        WHERE version = 12;
        DROP TABLE password_vault_key_cleanup;
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
        INSERT INTO schema_migrations(version, name)
        VALUES (13, 'automatic-password-vault');
        PRAGMA user_version = 13;
      `);
      draft
        .prepare(`
          INSERT INTO password_vault(
            singleton, format_version, kdf_algorithm, kdf_salt,
            kdf_cost, kdf_block_size, kdf_parallelism,
            master_key_nonce, master_key_ciphertext, master_key_tag,
            device_key_nonce, device_key_ciphertext, device_key_tag
          ) VALUES (1, 2, 'scrypt', ?, 1024, 8, 1, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          Buffer.alloc(16, 3),
          Buffer.alloc(12, 4),
          Buffer.alloc(32, 5),
          Buffer.alloc(16, 6),
          Buffer.alloc(12, 7),
          Buffer.alloc(32, 8),
          Buffer.alloc(16, 9),
        );
    } finally {
      draft.close();
    }

    database = new MuxusDatabase(filename);
    expect(database.appliedMigrations().at(-1)).toEqual({
      version: 18,
      name: 'lock-workspaces',
    });
    expect(database.passwordVaultConfig()).toMatchObject({
      formatVersion: 2,
      unlockPolicy: 'startup',
    });
    expect(database.passwordVaultConfig()!.vaultId).toHaveLength(21);
    expect(database.passwordVaultConfig()!.keyCheck).toBeUndefined();
    expect(
      database.listEncryptedCredentials(
        'muxus-master-vault',
        'muxus/ssh-password/v1',
      ),
    ).toHaveLength(1);
  });
});

describe('terminal scrollback snapshots', () => {
  const layoutWith = (tabId: string) => ({
    version: 1,
    root: {
      id: 'pane-1',
      type: 'pane',
      tabs: [
        {
          id: tabId,
          kind: 'terminal',
          title: 'Router',
          profile: { kind: 'ssh', target: 'router' },
          offerReconnect: true,
        },
      ],
    },
  });

  it('stores and replaces one snapshot per tab', () => {
    database = new MuxusDatabase(':memory:');
    database.saveTerminalSnapshot('tab-1', 'first');
    expect(database.terminalSnapshot('tab-1')).toMatchObject({ formatVersion: 1 });

    database.saveTerminalSnapshot('tab-1', 'second', 2);
    expect(database.terminalSnapshot('tab-1')).toMatchObject({
      tabId: 'tab-1',
      data: 'second',
      formatVersion: 2,
    });
    expect(database.terminalSnapshot('tab-2')).toBeUndefined();
  });

  it('prunes snapshots no stored workspace references', () => {
    database = new MuxusDatabase(':memory:');
    database.saveWorkspace({ name: 'Ops', layout: layoutWith('kept-tab') });
    database.saveTerminalSnapshot('kept-tab', 'kept');
    database.saveTerminalSnapshot('orphan-tab', 'orphan');

    expect(database.pruneTerminalSnapshots(0)).toBe(1);
    expect(database.terminalSnapshot('kept-tab')).toBeDefined();
    expect(database.terminalSnapshot('orphan-tab')).toBeUndefined();
  });

  it('spares fresh snapshots that may precede their first layout autosave', () => {
    database = new MuxusDatabase(':memory:');
    database.saveTerminalSnapshot('brand-new-tab', 'early output');

    expect(database.pruneTerminalSnapshots()).toBe(0);
    expect(database.terminalSnapshot('brand-new-tab')).toBeDefined();
  });
});

describe('persistent session history', () => {
  it('inherits safe defaults and supports per-host logging policy overrides', () => {
    database = new MuxusDatabase(':memory:');

    expect(database.sessionLoggingPolicy('ssh:production')).toMatchObject({
      enabled: false,
      captureInput: false,
      maxPartBytes: 5 * 1024 * 1024,
      maxParts: 10,
      overridden: false,
    });

    database.saveSessionLoggingPolicy('*', {
      enabled: true,
      captureInput: false,
      maxPartBytes: 1024 * 1024,
      maxParts: 4,
    });
    database.saveSessionLoggingPolicy('ssh:production', {
      enabled: false,
      captureInput: true,
      maxPartBytes: 2 * 1024 * 1024,
      maxParts: 2,
    });

    expect(database.sessionLoggingPolicy('ssh:production')).toMatchObject({
      enabled: false,
      captureInput: true,
      maxPartBytes: 2 * 1024 * 1024,
      maxParts: 2,
      overridden: true,
    });
    expect(database.sessionLoggingPolicy('ssh:staging')).toMatchObject({
      maxPartBytes: 1024 * 1024,
      maxParts: 4,
      overridden: false,
    });
    expect(database.deleteSessionLoggingPolicy('ssh:production')).toBe(true);
    expect(database.sessionLoggingPolicy('ssh:production')).toMatchObject({
      maxParts: 4,
      overridden: false,
    });
  });

});

describe('saved tunnels', () => {
  it('round-trips create, update and delete', () => {
    database = new MuxusDatabase(':memory:');

    const created = database.saveTunnel({ name: 'DB', target: 'web', type: 'local', bindPort: 5432, targetHost: 'localhost', targetPort: 5432 });
    expect(created).toMatchObject({ name: 'DB', target: 'web', type: 'local', bindPort: 5432, targetHost: 'localhost', targetPort: 5432 });

    const updated = database.saveTunnel({ id: created.id, target: 'web', type: 'dynamic', bindPort: 1080 });
    expect(updated).toMatchObject({ id: created.id, name: undefined, type: 'dynamic', bindPort: 1080, targetHost: undefined, targetPort: undefined });
    expect(database.listTunnels()).toHaveLength(1);

    expect(database.deleteTunnel(created.id)).toBe(true);
    expect(database.listTunnels()).toHaveLength(0);
  });

  it('rejects local/remote rules without a tunnel target', () => {
    const db = new MuxusDatabase(':memory:');
    database = db;
    expect(() => db.saveTunnel({ target: 'web', type: 'local', bindPort: 8080 })).toThrow(/targetHost/);
  });

  it('persists a tunnel-owned SSH profile without credentials', () => {
    database = new MuxusDatabase(':memory:');
    const created = database.saveTunnel({
      name: 'Private database',
      target: 'db.internal',
      sshOptions: {
        user: 'deploy',
        port: 2222,
        identityFiles: ['~/.ssh/work_ed25519'],
        identitiesOnly: true,
        proxyJump: ['bastion', 'ops@relay.example.com:2200'],
      },
      type: 'local',
      bindPort: 5432,
      targetHost: 'localhost',
      targetPort: 5432,
    });

    expect(created.sshOptions).toEqual({
      user: 'deploy',
      port: 2222,
      identityFiles: ['~/.ssh/work_ed25519'],
      identitiesOnly: true,
      proxyJump: ['bastion', 'ops@relay.example.com:2200'],
    });

    const switchedToHost = database.saveTunnel({
      id: created.id,
      target: 'database-config-alias',
      type: 'dynamic',
      bindPort: 1080,
    });
    expect(switchedToHost.sshOptions).toBeUndefined();
  });
});

describe('hybrid OpenSSH metadata', () => {
  it('stores Muxus metadata without copying connection details', () => {
    database = new MuxusDatabase(':memory:');

    const organized = database.updateOpenSshMetadata('production', {
      displayName: 'Production',
      group: 'Work',
      color: '#3b82f6',
      keywordHighlights: {
        inheritGlobal: true,
        rules: [
          {
            id: 'host-error',
            keyword: 'ERROR',
            foreground: '#ffffff',
            background: '#b91c1c',
            caseSensitive: false,
            wholeWord: true,
          },
        ],
      },
    });
    const connected = database.recordOpenSshConnection('production');

    expect(connected).toMatchObject({
      profileId: organized.profileId,
      displayName: 'Production',
      group: 'Work',
      color: '#3b82f6',
      keywordHighlights: {
        inheritGlobal: true,
        rules: [expect.objectContaining({ keyword: 'ERROR' })],
      },
      connectCount: 1,
    });
    expect(database.openSshMetadata(['production']).get('production')).toEqual(connected);
  });

  it('moves hosts between case-insensitive groups and can clear organization', () => {
    database = new MuxusDatabase(':memory:');

    database.updateOpenSshMetadata('one', { group: 'Production', color: '#ef4444' });
    const grouped = database.updateOpenSshMetadata('two', { group: 'production' });
    const cleared = database.updateOpenSshMetadata('one', { group: null, color: null });

    // One group, not two — but the latest spelling wins, so renaming a sidebar
    // folder to fix its capitalization actually takes effect.
    expect(grouped).toMatchObject({ group: 'production' });
    expect(cleared.group).toBeUndefined();
    expect(cleared.color).toBeUndefined();
  });

  it('applies a case-only group rename to every host already in it', () => {
    database = new MuxusDatabase(':memory:');

    database.updateOpenSshMetadata('one', { group: 'prod' });
    database.updateOpenSshMetadata('two', { group: 'prod' });
    database.updateOpenSshMetadata('one', { group: 'Prod' });

    const metadata = database.openSshMetadata(['one', 'two']);
    expect(metadata.get('one')).toMatchObject({ group: 'Prod' });
    expect(metadata.get('two')).toMatchObject({ group: 'Prod' });
  });

  it('preserves the stable profile ID when an OpenSSH alias is renamed', () => {
    database = new MuxusDatabase(':memory:');
    const before = database.updateOpenSshMetadata('old-alias', { group: 'Work' });
    database.recordOpenSshConnection('old-alias');
    database.saveSessionLoggingPolicy('ssh:old-alias', {
      enabled: true,
      captureInput: false,
      maxPartBytes: 2 * 1024 * 1024,
      maxParts: 3,
    });
    database.renameOpenSshAlias('old-alias', 'new-alias');

    expect(database.openSshMetadata(['old-alias']).size).toBe(0);
    expect(database.openSshMetadata(['new-alias']).get('new-alias')).toMatchObject({
      profileId: before.profileId,
      group: 'Work',
      connectCount: 1,
    });
    expect(database.sessionLoggingPolicy('ssh:old-alias').overridden).toBe(false);
    expect(database.sessionLoggingPolicy('ssh:new-alias')).toMatchObject({
      enabled: true,
      maxPartBytes: 2 * 1024 * 1024,
      maxParts: 3,
      overridden: true,
    });
  });

  it('persists one drag order across OpenSSH hosts and saved Telnet/serial hosts', () => {
    database = new MuxusDatabase(':memory:');
    const saved = database.saveSavedHostProfile({
      name: 'Core router',
      profile: { kind: 'telnet', host: 'router.example.test', port: 23 },
    });

    database.reorderManagedHosts([
      { kind: 'ssh', alias: 'gamma' },
      { kind: 'profile', id: saved.id },
      { kind: 'ssh', alias: 'alpha' },
    ]);

    expect([...database.openSshMetadata(['alpha', 'gamma'])]).toEqual([
      ['alpha', expect.objectContaining({ sortOrder: 2 })],
      ['gamma', expect.objectContaining({ sortOrder: 0 })],
    ]);
    expect(database.savedHostProfile(saved.id)?.metadata.sortOrder).toBe(1);

    expect(() =>
      database!.reorderManagedHosts([
        { kind: 'ssh', alias: 'alpha' },
        { kind: 'ssh', alias: 'alpha' },
      ]),
    ).toThrow(/duplicate/);
    expect(() =>
      database!.reorderManagedHosts([{ kind: 'profile', id: 'missing' }]),
    ).toThrow(/not found/);
  });
});

describe('saved Telnet and serial hosts', () => {
  it('upserts supplied import IDs without crossing connection-kind ownership', () => {
    database = new MuxusDatabase(':memory:');
    const created = database.saveSavedHostProfile({
      id: 'securecrt-serial-console',
      name: 'Imported console',
      profile: {
        kind: 'serial',
        path: '/dev/ttyUSB0',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      },
    });
    expect(created.id).toBe('securecrt-serial-console');

    const localId = database.createNativeConnection({
      kind: 'local',
      name: 'Local shell',
      config: {},
    });
    expect(() =>
      database!.saveSavedHostProfile({
        id: localId,
        name: 'Wrong owner',
        profile: { kind: 'telnet', host: 'example.test', port: 23 },
      }),
    ).toThrow(/different connection type/);
  });

  it('round-trips connection settings, organization, recent use, updates, and deletion', () => {
    database = new MuxusDatabase(':memory:');

    const created = database.saveSavedHostProfile({
      name: 'Rack console',
      profile: {
        kind: 'serial',
        path: '/dev/ttyUSB0',
        baudRate: 115_200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'hardware',
      },
    });
    const organized = database.updateSavedHostMetadata(created.id, {
      displayName: 'Core rack console',
      group: 'Lab',
      color: '#3b82f6',
    });
    database.recordSavedHostConnection(created.id);

    expect(organized).toMatchObject({
      id: created.id,
      kind: 'serial',
      name: 'Core rack console',
      profile: {
        kind: 'serial',
        profileId: created.id,
        path: '/dev/ttyUSB0',
        baudRate: 115_200,
        flowControl: 'hardware',
      },
      metadata: {
        group: 'Lab',
        color: '#3b82f6',
      },
    });
    expect(database.savedHostProfile(created.id)?.metadata.connectCount).toBe(1);

    const updated = database.saveSavedHostProfile({
      id: created.id,
      name: 'Console server',
      profile: {
        kind: 'telnet',
        host: 'console.example.test',
        port: 2323,
      },
    });
    expect(updated).toMatchObject({
      id: created.id,
      kind: 'telnet',
      name: 'Console server',
      profile: {
        kind: 'telnet',
        profileId: created.id,
        host: 'console.example.test',
        port: 2323,
      },
      metadata: {
        group: 'Lab',
        color: '#3b82f6',
        connectCount: 1,
      },
    });
    expect(database.listSavedHostProfiles()).toEqual([updated]);
    database.saveSessionLoggingPolicy(`profile:${created.id}`, {
      enabled: true,
      captureInput: false,
      maxPartBytes: 1024 * 1024,
      maxParts: 2,
    });
    expect(database.deleteSavedHostProfile(created.id)).toBe(true);
    expect(database.listSavedHostProfiles()).toEqual([]);
    expect(database.sessionLoggingPolicy(`profile:${created.id}`).overridden).toBe(false);
  });

  it('rejects secrets in native host settings', () => {
    database = new MuxusDatabase(':memory:');

    expect(() =>
      database!.saveSavedHostProfile({
        name: 'Unsafe',
        profile: {
          kind: 'telnet',
          host: 'router.example.test',
          port: 23,
          password: 'do-not-save',
        } as never,
      }),
    ).toThrow(/password vault/);
  });
});

describe('credential and workspace safety', () => {
  it('rolls back a new credential reference when encryption fails', () => {
    database = new MuxusDatabase(':memory:');
    const input = {
      provider: 'muxus-master-vault',
      service: 'muxus/ssh-password/v1',
      account: 'failed-encryption',
      label: 'Failed encryption',
    };
    let rolledBackId = '';

    expect(() =>
      database!.upsertEncryptedCredentialAtomically(input, (ref) => {
        rolledBackId = ref.id;
        throw new Error('sealing failed');
      }),
    ).toThrow('sealing failed');

    const next = database.upsertCredentialRef(input);
    expect(next.id).not.toBe(rolledBackId);
  });

  it('stores only a credential reference alongside native profile data', () => {
    database = new MuxusDatabase(':memory:');
    const credential = database.upsertCredentialRef({
      provider: 'os-keychain',
      service: 'muxus/ssh',
      account: 'alice@example.com',
      label: 'Production SSH',
    });

    expect(() =>
      database!.createNativeConnection({
        kind: 'ssh',
        name: 'Production',
        config: { host: 'example.com', identityFile: '/home/alice/.ssh/id_ed25519' },
        credentialRefId: credential.id,
      }),
    ).not.toThrow();
  });

  it('rejects secrets anywhere in persisted profile or workspace JSON', () => {
    database = new MuxusDatabase(':memory:');
    expect(() => assertSecretFree({ nested: { password: 'hunter2' } })).toThrow(/password vault/);
    expect(() => assertSecretFree({ auth: { privateKeyPem: '-----BEGIN PRIVATE KEY-----' } })).toThrow(
      /password vault/,
    );
    expect(() => assertSecretFree({ auth: { api_token_value: 'secret' } })).toThrow(/password vault/);
    expect(() =>
      assertSecretFree({
        auth: {
          privateKeyPath: '/home/alice/.ssh/id_ed25519',
          passwordCredentialRefId: 'credential-1',
        },
      }),
    ).not.toThrow();
    expect(() =>
      database!.createNativeConnection({
        kind: 'ssh',
        name: 'Unsafe',
        config: { auth: { passphrase: 'secret' } },
      }),
    ).toThrow(/password vault/);
    expect(() =>
      database!.saveWorkspace({
        name: 'Unsafe',
        layout: { pane: { token: 'secret' } },
      }),
    ).toThrow(/password vault/);
  });

  it('round-trips a secret-free recoverable workspace layout', () => {
    database = new MuxusDatabase(':memory:');
    const saved = database.saveWorkspace({
      name: 'Daily work',
      multiExecGroups: [
        { id: 'prod', name: 'Production', tabIds: ['tab-a', 'tab-b'] },
      ],
      layout: {
        version: 1,
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          children: [
            { type: 'terminal', profileRef: 'profile-a', cwdHint: '/srv/app' },
            { type: 'sftp', profileRef: 'profile-a', path: '/var/log' },
          ],
        },
      },
    });

    expect(database.workspace(saved.id)).toEqual(saved);
    expect(saved).toMatchObject({
      isLocked: false,
      isStartup: false,
      multiExecGroups: [
        { id: 'prod', name: 'Production', tabIds: ['tab-a', 'tab-b'] },
      ],
    });
  });

  it('renames, opens, and selects exactly one startup workspace', () => {
    database = new MuxusDatabase(':memory:');
    const first = database.saveWorkspace({ name: 'First', layout: { version: 1, root: null } });
    const second = database.saveWorkspace({ name: 'Second', layout: { version: 1, root: null } });

    expect(database.renameWorkspace(first.id, 'Daily')).toMatchObject({ name: 'Daily' });
    expect(database.openWorkspace(first.id)?.lastOpenedAt).toBeDefined();
    expect(database.setStartupWorkspace(first.id)).toMatchObject({ id: first.id, isStartup: true });
    expect(database.setStartupWorkspace(second.id)).toMatchObject({ id: second.id, isStartup: true });
    expect(database.workspace(first.id)?.isStartup).toBe(false);
    expect(database.startupWorkspace()?.id).toBe(second.id);
    expect(database.listWorkspaceSummaries().filter((workspace) => workspace.isStartup)).toHaveLength(1);
    expect(database.setStartupWorkspace(null)).toBeUndefined();
    expect(database.startupWorkspace()).toBeUndefined();
  });

  it('locks and unlocks a workspace without changing its layout', () => {
    database = new MuxusDatabase(':memory:');
    const saved = database.saveWorkspace({
      name: 'Stable startup',
      layout: { version: 1, root: null },
    });

    expect(database.setWorkspaceLocked(saved.id, true)).toMatchObject({
      id: saved.id,
      isLocked: true,
      layout: saved.layout,
    });
    expect(database.listWorkspaceSummaries()).toEqual([
      expect.objectContaining({ id: saved.id, isLocked: true }),
    ]);
    expect(() =>
      database!.saveWorkspace({
        id: saved.id,
        name: saved.name,
        layout: { version: 1, root: { id: 'unexpected' } },
      }),
    ).toThrow(WorkspaceLockedError);
    expect(database.workspace(saved.id)?.layout).toEqual(saved.layout);

    const explicitlySaved = database.saveWorkspace(
      {
        id: saved.id,
        name: saved.name,
        layout: { version: 1, root: { id: 'explicit' } },
      },
      true,
    );
    expect(explicitlySaved).toMatchObject({
      id: saved.id,
      isLocked: true,
      layout: { version: 1, root: { id: 'explicit' } },
    });
    expect(database.setWorkspaceLocked(saved.id, false)).toMatchObject({
      id: saved.id,
      isLocked: false,
    });
  });
});
