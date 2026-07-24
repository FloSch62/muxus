import { afterEach, describe, expect, it } from 'vitest';
import { MuxusDatabase, assertSecretFree } from '../../../server/src/persistence/database.js';

let database: MuxusDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
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
    ]);
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

    const favorite = database.updateOpenSshMetadata('production', {
      favorite: true,
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
      profileId: favorite.profileId,
      favorite: true,
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

    expect(grouped).toMatchObject({ group: 'Production' });
    expect(cleared).toMatchObject({ favorite: false });
    expect(cleared.group).toBeUndefined();
    expect(cleared.color).toBeUndefined();
  });

  it('preserves the stable profile ID when an OpenSSH alias is renamed', () => {
    database = new MuxusDatabase(':memory:');
    const before = database.updateOpenSshMetadata('old-alias', { favorite: true });
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
      favorite: true,
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
      favorite: true,
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
        favorite: true,
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
        favorite: true,
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
    ).toThrow(/OS credential store/);
  });
});

describe('credential and workspace safety', () => {
  it('stores only an OS credential reference alongside native profile data', () => {
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
    expect(() => assertSecretFree({ nested: { password: 'hunter2' } })).toThrow(/OS credential store/);
    expect(() => assertSecretFree({ auth: { privateKeyPem: '-----BEGIN PRIVATE KEY-----' } })).toThrow(
      /OS credential store/,
    );
    expect(() => assertSecretFree({ auth: { api_token_value: 'secret' } })).toThrow(/OS credential store/);
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
    ).toThrow(/OS credential store/);
    expect(() =>
      database!.saveWorkspace({
        name: 'Unsafe',
        layout: { pane: { token: 'secret' } },
      }),
    ).toThrow(/OS credential store/);
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
});
