import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderSettingsRecord, LoginSequence, SavedHostProfile } from '@muxus/shared';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { resolveLoginSequence } from '../../../server/src/login-sequence/resolve.js';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';

const TOKEN = 'login-sequence-token';

const enable: LoginSequence = {
  steps: [
    { id: 'a', kind: 'wait', pattern: '>', timeoutSeconds: 10 },
    { id: 'b', kind: 'send', text: 'enable', enter: true },
    { id: 'c', kind: 'secret', secretId: 'secret-1', enter: true },
  ],
};
const banner: LoginSequence = {
  steps: [
    { id: 'x', kind: 'wait', pattern: 'Press RETURN', timeoutSeconds: 30 },
    { id: 'y', kind: 'send', text: '', enter: true },
  ],
};
const none: LoginSequence = { steps: [] };

describe('login sequence storage', () => {
  let database: MuxusDatabase;

  beforeEach(() => {
    database = new MuxusDatabase(':memory:');
  });
  afterEach(() => database.close());

  it('stores a host sequence in the metadata of OpenSSH and Muxus-owned hosts', () => {
    expect(database.updateOpenSshMetadata('core-sw', { loginSequence: enable }).loginSequence).toEqual(enable);
    expect(database.openSshMetadata(['core-sw']).get('core-sw')?.loginSequence).toEqual(enable);
    // Other metadata edits keep it; null goes back to inheriting.
    expect(database.updateOpenSshMetadata('core-sw', { color: '#ff0000' }).loginSequence).toEqual(enable);
    expect(database.updateOpenSshMetadata('core-sw', { loginSequence: null }).loginSequence).toBeUndefined();

    const telnet = database.saveSavedHostProfile({
      name: 'Console server',
      profile: { kind: 'telnet', host: 'console.lab', port: 23 },
    });
    const updated = database.updateSavedHostMetadata(telnet.id, { loginSequence: banner, group: 'Lab' });
    expect(updated.metadata.loginSequence).toEqual(banner);
    expect(database.listSavedHostProfiles()[0]?.metadata.loginSequence).toEqual(banner);
    expect(database.hostLoginSequence({ profileId: telnet.id })).toEqual({
      loginSequence: banner,
      group: 'Lab',
    });
    expect(database.hostLoginSequence({ profileId: 'missing' })).toBeUndefined();
    expect(database.hostLoginSequence({ alias: 'unknown' })).toBeUndefined();
  });

  it('keeps the sequence when the alias is renamed', () => {
    database.updateOpenSshMetadata('router', { loginSequence: enable, group: 'Core' });
    database.renameOpenSshAlias('router', 'router-1');
    expect(database.hostLoginSequence({ alias: 'router-1' })).toEqual({ loginSequence: enable, group: 'Core' });
  });

  it('rejects secret values at the persistence boundary', () => {
    const leaky = { steps: [{ id: 'z', kind: 'send', text: 'x', enter: true, password: 'hunter2' }] };
    expect(() => database.updateOpenSshMetadata('core-sw', { loginSequence: leaky as never })).toThrow(
      /password vault/,
    );
  });

  it('stores folder sequences that follow the folder when it moves', () => {
    const row = database.upsertFolderSettings('Network', {});
    database.setFolderLoginSequence(row.id, enable);
    expect(database.folderSettingsForPath('network')?.loginSequence).toEqual(enable);
    // Saving the credentials again keeps the sequence.
    database.upsertFolderSettings('Network', { user: 'admin' });
    expect(database.folderSettingsForPath('Network')?.loginSequence).toEqual(enable);
    database.moveFolderSettings('Network', 'Infra/Network');
    expect(database.folderSettingsForPath('Infra/Network')?.loginSequence).toEqual(enable);
    database.setFolderLoginSequence(row.id, null);
    expect(database.folderSettingsForPath('Infra/Network')?.loginSequence).toBeUndefined();
  });
});

describe('login sequence inheritance', () => {
  let database: MuxusDatabase;

  beforeEach(() => {
    database = new MuxusDatabase(':memory:');
    database.setFolderLoginSequence(database.upsertFolderSettings('Network', {}).id, enable);
    database.setFolderLoginSequence(database.upsertFolderSettings('Network/Consoles', {}).id, banner);
    database.setFolderLoginSequence(database.upsertFolderSettings('Network/Lab', {}).id, none);
  });
  afterEach(() => database.close());

  const resolve = (alias: string) => resolveLoginSequence(database, { alias });

  it('uses the nearest folder that sets one', () => {
    database.updateOpenSshMetadata('core', { group: 'Network' });
    database.updateOpenSshMetadata('edge', { group: 'Network/EU/Edge' });
    database.updateOpenSshMetadata('ts1', { group: 'network/consoles' });
    expect(resolve('core')).toEqual(enable);
    expect(resolve('edge')).toEqual(enable);
    expect(resolve('ts1')).toEqual(banner);
  });

  it('lets a host or a subfolder override or switch it off', () => {
    database.updateOpenSshMetadata('own', { group: 'Network/Consoles', loginSequence: enable });
    database.updateOpenSshMetadata('off', { group: 'Network', loginSequence: none });
    database.updateOpenSshMetadata('lab', { group: 'Network/Lab/Bench' });
    expect(resolve('own')).toEqual(enable);
    expect(resolve('off')).toBeUndefined();
    expect(resolve('lab')).toBeUndefined();
  });

  it('runs nothing for hosts outside any folder with a sequence', () => {
    database.updateOpenSshMetadata('loose', { color: '#00ff00' });
    database.updateOpenSshMetadata('elsewhere', { group: 'Servers' });
    expect(resolve('loose')).toBeUndefined();
    expect(resolve('elsewhere')).toBeUndefined();
    expect(resolve('never-seen')).toBeUndefined();
  });

  it('resolves Muxus-owned hosts by their profile id', () => {
    const serial = database.saveSavedHostProfile({
      name: 'Bench console',
      profile: {
        kind: 'serial',
        path: '/dev/ttyUSB0',
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      },
    });
    database.updateSavedHostMetadata(serial.id, { group: 'Network/Consoles' });
    expect(resolveLoginSequence(database, { profileId: serial.id })).toEqual(banner);
  });
});

describe('login sequence routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'muxus-login-sequence-'));
    vi.stubEnv('HOME', home);
    ({ app } = await buildApp(
      resolveConfig({
        token: TOKEN,
        databasePath: ':memory:',
        openBrowser: false,
        prettyLogs: false,
        staticRoot: '/path/that/does/not/exist',
      }),
    ));
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const headers = { authorization: `Bearer ${TOKEN}` };
  const request = (method: 'GET' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers, payload: payload as never });

  it('saves and validates a host sequence through the metadata patch', async () => {
    const saved = await request('PUT', '/api/profiles', {
      name: 'Router',
      profile: { kind: 'telnet', host: 'router.lab', port: 23 },
    });
    const id = (saved.json() as SavedHostProfile).id;

    const ok = await request('PATCH', `/api/profiles/${id}/metadata`, { loginSequence: enable });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as SavedHostProfile).metadata.loginSequence).toEqual(enable);

    const invalid = [
      { steps: [{ id: 'a', kind: 'wait', pattern: '([', regex: true, timeoutSeconds: 5 }] },
      { steps: [{ id: 'a', kind: 'wait', pattern: '', timeoutSeconds: 5 }] },
      { steps: [{ id: 'a', kind: 'wait', pattern: 'x', timeoutSeconds: 0 }] },
      { steps: [{ id: 'a', kind: 'send', text: '', enter: false }] },
      { steps: [{ id: 'a', kind: 'secret', secretId: '', enter: true }] },
      { steps: Array.from({ length: 33 }, (_, index) => ({ id: `s${index}`, kind: 'send', text: 'x', enter: true })) },
    ];
    for (const loginSequence of invalid) {
      const rejected = await request('PATCH', `/api/profiles/${id}/metadata`, { loginSequence });
      expect(rejected.statusCode, JSON.stringify(loginSequence)).toBe(400);
    }

    const cleared = await request('PATCH', `/api/profiles/${id}/metadata`, { loginSequence: null });
    expect((cleared.json() as SavedHostProfile).metadata.loginSequence).toBeUndefined();
  });

  it('keeps a folder that only holds a login sequence', async () => {
    const put = await request('PUT', '/api/folders/settings', {
      path: 'Network',
      auth: {},
      loginSequence: enable,
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { folder: FolderSettingsRecord }).folder).toMatchObject({
      path: 'Network',
      loginSequence: enable,
    });

    // Saving the credentials without the sequence field leaves it alone.
    await request('PUT', '/api/folders/settings', { path: 'Network', auth: { user: 'admin' } });
    let folders = ((await request('GET', '/api/folders/settings')).json() as { folders: FolderSettingsRecord[] })
      .folders;
    expect(folders).toMatchObject([{ auth: { user: 'admin' }, loginSequence: enable }]);

    await request('PUT', '/api/folders/settings', { path: 'Network', auth: {} });
    folders = ((await request('GET', '/api/folders/settings')).json() as { folders: FolderSettingsRecord[] })
      .folders;
    expect(folders).toMatchObject([{ auth: {}, loginSequence: enable }]);

    const cleared = await request('PUT', '/api/folders/settings', {
      path: 'Network',
      auth: {},
      loginSequence: null,
    });
    expect(cleared.json()).toEqual({ folder: null });

    const bad = await request('PUT', '/api/folders/settings', {
      path: 'Network',
      auth: {},
      loginSequence: { steps: [{ id: 'a', kind: 'wait', pattern: '(', regex: true, timeoutSeconds: 5 }] },
    });
    expect(bad.statusCode).toBe(400);
  });
});
