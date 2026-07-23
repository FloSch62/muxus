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
    ]);
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
    });
    const connected = database.recordOpenSshConnection('production');

    expect(connected).toMatchObject({
      profileId: favorite.profileId,
      favorite: true,
      displayName: 'Production',
      group: 'Work',
      color: '#3b82f6',
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

    database.renameOpenSshAlias('old-alias', 'new-alias');

    expect(database.openSshMetadata(['old-alias']).size).toBe(0);
    expect(database.openSshMetadata(['new-alias']).get('new-alias')).toMatchObject({
      profileId: before.profileId,
      favorite: true,
      connectCount: 1,
    });
  });

  it('persists a complete drag order for otherwise-unmodified OpenSSH hosts', () => {
    database = new MuxusDatabase(':memory:');

    database.reorderOpenSshHosts(['gamma', 'alpha', 'beta']);

    expect([...database.openSshMetadata(['alpha', 'beta', 'gamma'])]).toEqual([
      ['alpha', expect.objectContaining({ sortOrder: 1 })],
      ['beta', expect.objectContaining({ sortOrder: 2 })],
      ['gamma', expect.objectContaining({ sortOrder: 0 })],
    ]);
    expect(() => database!.reorderOpenSshHosts(['alpha', 'alpha'])).toThrow(/duplicate/);
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
  });
});
