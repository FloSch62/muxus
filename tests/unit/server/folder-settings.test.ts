import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderSettingsRecord } from '@muxus/shared';
import type { AppContext } from '../../../server/src/app.js';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';

const TOKEN = 'folder-settings-token';
const MASTER = 'master-pass-12';

describe('folder settings persistence', () => {
  let database: MuxusDatabase;

  beforeEach(() => {
    database = new MuxusDatabase(':memory:');
  });
  afterEach(() => database.close());

  it('upserts by case-folded path and keeps the row id stable', () => {
    const created = database.upsertFolderSettings('Prod/EU', { user: 'admin' });
    const updated = database.upsertFolderSettings('prod/eu', { user: 'root', port: 2222 });
    expect(updated.id).toBe(created.id);
    expect(updated.path).toBe('prod/eu');
    expect(updated.auth).toEqual({ user: 'root', port: 2222 });
    expect(database.listFolderSettings()).toHaveLength(1);
    expect(database.folderSettingsForPath(' Prod / EU ')?.id).toBe(created.id);
  });

  it('rejects secret-shaped fields at the persistence boundary', () => {
    expect(() =>
      database.upsertFolderSettings('Prod', {
        password: 'nope',
      } as never),
    ).toThrowError(/password vault/);
  });

  it('moves a folder and its descendants, keeping ids', () => {
    const prod = database.upsertFolderSettings('Prod', { user: 'root' });
    const eu = database.upsertFolderSettings('Prod/EU', { port: 2222 });
    database.upsertFolderSettings('Staging', { user: 'stage' });

    const { moved, dropped } = database.moveFolderSettings('Prod', 'Production');
    expect(moved).toBe(2);
    expect(dropped).toEqual([]);
    expect(database.folderSettingsForPath('Production')?.id).toBe(prod.id);
    expect(database.folderSettingsForPath('Production/EU')?.id).toBe(eu.id);
    expect(database.folderSettingsForPath('Staging')).toBeDefined();
    expect(database.folderSettingsForPath('Prod')).toBeUndefined();
  });

  it('keeps the destination settings when a move merges folders', () => {
    const source = database.upsertFolderSettings('Prod', { user: 'source' });
    const destination = database.upsertFolderSettings('Production', { user: 'dest' });

    const { dropped } = database.moveFolderSettings('Prod', 'Production');
    expect(dropped.map((row) => row.id)).toEqual([source.id]);
    expect(database.folderSettingsForPath('Production')?.id).toBe(destination.id);
    expect(database.folderSettingsForPath('Production')?.auth).toEqual({ user: 'dest' });
  });

  it('updates only the display path on a recapitalization', () => {
    const row = database.upsertFolderSettings('prod', { user: 'root' });
    database.moveFolderSettings('prod', 'Prod');
    const after = database.folderSettingsForPath('prod');
    expect(after?.id).toBe(row.id);
    expect(after?.path).toBe('Prod');
  });

  it('deleting a folder promotes descendant settings a level up', () => {
    const own = database.upsertFolderSettings('Prod/EU', { user: 'eu' });
    const edge = database.upsertFolderSettings('Prod/EU/Edge', { port: 2222 });

    const { removed } = database.deleteFolderSettings('Prod/EU');
    expect(removed.map((row) => row.id)).toEqual([own.id]);
    expect(database.folderSettingsForPath('Prod/Edge')?.id).toBe(edge.id);
    expect(database.folderSettingsForPath('Prod/EU')).toBeUndefined();
  });
});

describe('folder settings routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: AppContext;
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'muxus-folder-routes-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    ({ app, ctx } = await buildApp(
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
    vi.restoreAllMocks();
  vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function auth() {
    return { authorization: `Bearer ${TOKEN}` };
  }

  async function listFolders(): Promise<FolderSettingsRecord[]> {
    const res = await app.inject({ method: 'GET', url: '/api/folders/settings', headers: auth() });
    expect(res.statusCode).toBe(200);
    return (res.json() as { folders: FolderSettingsRecord[] }).folders;
  }

  it('round-trips settings and drops rows that hold nothing', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/folders/settings',
      headers: auth(),
      payload: { path: ' Prod / EU ', auth: { user: '  admin ', port: 2222, identityFiles: [' ~/.ssh/prod ', ''] } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      folder: {
        path: 'Prod/EU',
        auth: { user: 'admin', port: 2222, identityFiles: ['~/.ssh/prod'] },
        hasPassword: false,
      },
    });

    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/folders/settings',
      headers: auth(),
      payload: { path: 'Prod/EU', auth: {} },
    });
    expect(cleared.json()).toEqual({ folder: null });
    expect(await listFolders()).toEqual([]);
  });

  it('stores and removes the shared folder password through the vault', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/password-vault/create',
      headers: auth(),
      payload: { password: MASTER },
    });
    expect(created.statusCode).toBe(200);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/folders/settings/password',
      headers: auth(),
      payload: { path: 'Prod', password: 'shared-secret' },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { folder: FolderSettingsRecord }).folder.hasPassword).toBe(true);

    const [folder] = await listFolders();
    expect(folder).toMatchObject({ path: 'Prod', hasPassword: true });

    const vault = await app.inject({ method: 'GET', url: '/api/password-vault', headers: auth() });
    expect(vault.json()).toMatchObject({
      credentials: [{ label: 'Folder Prod' }],
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/folders/settings/password?path=Prod',
      headers: auth(),
    });
    expect(removed.json()).toEqual({ deleted: true });
    // The row held nothing but the password, so it disappears entirely.
    expect(await listFolders()).toEqual([]);
  });

  it('requires a configured vault before storing a folder password', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/folders/settings/password',
      headers: auth(),
      payload: { path: 'Prod', password: 'shared-secret' },
    });
    expect(put.statusCode).toBe(409);
    expect(await listFolders()).toEqual([]);
  });

  it('moves settings with the folder and relabels the vault credential', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/password-vault/create',
      headers: auth(),
      payload: { password: MASTER },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/folders/settings',
      headers: auth(),
      payload: { path: 'Prod', auth: { user: 'root' } },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/folders/settings/password',
      headers: auth(),
      payload: { path: 'Prod', password: 'shared-secret' },
    });

    const move = await app.inject({
      method: 'POST',
      url: '/api/folders/settings/move',
      headers: auth(),
      payload: { from: 'Prod', to: 'Production' },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json()).toEqual({ moved: 1, destinationPreserved: false });

    const [folder] = await listFolders();
    expect(folder).toMatchObject({ path: 'Production', auth: { user: 'root' }, hasPassword: true });

    const vault = await app.inject({ method: 'GET', url: '/api/password-vault', headers: auth() });
    expect(vault.json()).toMatchObject({ credentials: [{ label: 'Folder Production' }] });
  });

  it('reports when a merge preserves the destination settings', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/folders/settings',
      headers: auth(),
      payload: { path: 'Source', auth: { user: 'source' } },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/folders/settings',
      headers: auth(),
      payload: { path: 'Destination', auth: { user: 'destination', port: 2222 } },
    });

    const move = await app.inject({
      method: 'POST',
      url: '/api/folders/settings/move',
      headers: auth(),
      payload: { from: 'Source', to: 'Destination' },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json()).toEqual({ moved: 0, destinationPreserved: true });
    expect(await listFolders()).toEqual([
      expect.objectContaining({
        path: 'Destination',
        auth: { user: 'destination', port: 2222 },
      }),
    ]);
  });

  it('deletes settings and their vault password with the folder', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/password-vault/create',
      headers: auth(),
      payload: { password: MASTER },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/folders/settings/password',
      headers: auth(),
      payload: { path: 'Prod', password: 'shared-secret' },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/folders/settings',
      headers: auth(),
      payload: { path: 'Prod/EU', auth: { port: 2222 } },
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/folders/settings?path=${encodeURIComponent('Prod')}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ removed: 1 });

    const folders = await listFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ path: 'EU', auth: { port: 2222 } });

    const vault = await app.inject({ method: 'GET', url: '/api/password-vault', headers: auth() });
    expect(vault.json()).toMatchObject({ credentialCount: 0 });
  });

  it('feeds folder defaults into the resolved host list', async () => {
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    writeFileSync(
      path.join(home, '.ssh', 'config'),
      ['Host demo', '  HostName demo.example.com', '', 'Host plain', '  HostName plain.example.com'].join('\n'),
    );
    ctx.database.updateOpenSshMetadata('demo', { group: 'Prod' });
    ctx.database.upsertFolderSettings('Prod', { user: 'folderuser', port: 2222 });

    const config = await app.inject({ method: 'GET', url: '/api/ssh/config', headers: auth() });
    expect(config.statusCode).toBe(200);
    const hosts = (config.json() as {
      hosts: Array<{ alias: string; resolved: { user?: string; port: number } }>;
    }).hosts;
    expect(hosts.find((entry) => entry.alias === 'demo')?.resolved).toMatchObject({
      user: 'folderuser',
      port: 2222,
    });
    expect(hosts.find((entry) => entry.alias === 'plain')?.resolved).toMatchObject({
      port: 22,
    });
  });
});
