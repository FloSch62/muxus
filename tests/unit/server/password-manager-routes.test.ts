import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PasswordManagerSource, PasswordManagersResponse } from '@muxus/shared';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'password-manager-route-token';
const DATABASE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'keepassxc-kdbx3.kdbx');
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeEach(async () => {
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
});

const headers = { authorization: `Bearer ${TOKEN}` };
const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe('password manager routes', () => {
  it('connects a KeePass database, unlocks it and lists entries without passwords', async () => {
    const empty = (await request('GET', '/api/password-managers')).json() as PasswordManagersResponse;
    expect(empty.sources).toEqual([]);
    // KeePass needs no program, so it is always offered.
    expect(empty.installed).toContain('keepass');

    expect((await request('POST', '/api/password-managers', { kind: 'keepass', config: {} })).statusCode).toBe(400);
    const created = await request('POST', '/api/password-managers', {
      kind: 'keepass',
      config: { path: DATABASE },
    });
    const source = created.json() as PasswordManagerSource;
    expect(source).toMatchObject({ kind: 'keepass', name: 'KeePass – keepassxc-kdbx3', state: 'locked' });

    const locked = await request('GET', `/api/password-managers/${source.id}/entries`);
    expect(locked.statusCode).toBe(423);
    expect(locked.json()).toMatchObject({ code: 'password-manager-locked' });

    const wrong = await request('POST', `/api/password-managers/${source.id}/unlock`, { password: 'nope' });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toMatchObject({ code: 'password-manager-invalid-unlock' });
    const unlocked = await request('POST', `/api/password-managers/${source.id}/unlock`, {
      password: 'master-pw-1',
    });
    expect(unlocked.json()).toMatchObject({ state: 'ready' });

    const listed = await request('GET', `/api/password-managers/${source.id}/entries`);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.json().entries.map((entry: { title: string }) => entry.title)).toEqual(['Core router', 'web1']);
    expect(listed.body).not.toContain('hunter2');
    expect(listed.body).not.toContain('router-pw');

    expect((await request('POST', `/api/password-managers/${source.id}/lock`)).json()).toMatchObject({
      state: 'locked',
    });
    expect((await request('DELETE', `/api/password-managers/${source.id}`)).json()).toEqual({ deleted: true });
    expect((await request('GET', `/api/password-managers/${source.id}/entries`)).statusCode).toBe(404);
  });

  it('brings a manager back under the ID a restore gives, and refuses one that is taken', async () => {
    const restored = await request('POST', '/api/password-managers', {
      id: 'from-a-backup',
      kind: 'keepass',
      name: 'Work',
      config: { path: DATABASE },
    });
    expect(restored.json()).toMatchObject({ id: 'from-a-backup', name: 'Work', state: 'locked' });

    const again = await request('POST', '/api/password-managers', {
      id: 'from-a-backup',
      kind: 'keepass',
      config: { path: DATABASE },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'password-manager-exists' });

    // An ID in the body of an update names nothing: the address does.
    const updated = await request('PUT', '/api/password-managers/from-a-backup', {
      id: 'another',
      kind: 'keepass',
      name: 'Renamed',
      config: { path: DATABASE },
    });
    expect(updated.json()).toMatchObject({ id: 'from-a-backup', name: 'Renamed' });
    const listed = (await request('GET', '/api/password-managers')).json() as PasswordManagersResponse;
    expect(listed.sources.map((source) => source.id)).toEqual(['from-a-backup']);
  });

  it('locks a source again when its settings change', async () => {
    const source = (
      await request('POST', '/api/password-managers', { kind: 'keepass', config: { path: DATABASE } })
    ).json() as PasswordManagerSource;
    await request('POST', `/api/password-managers/${source.id}/unlock`, { password: 'master-pw-1' });
    const renamed = await request('PUT', `/api/password-managers/${source.id}`, {
      kind: 'keepass',
      name: 'Work',
      config: { path: DATABASE },
    });
    expect(renamed.json()).toMatchObject({ name: 'Work', state: 'ready' });
    const moved = await request('PUT', `/api/password-managers/${source.id}`, {
      kind: 'keepass',
      name: 'Work',
      config: { path: DATABASE, keyFile: '/somewhere/else.keyx' },
    });
    expect(moved.json()).toMatchObject({ state: 'locked' });
  });

  it('stores a folder entry as a reference and keeps the folder row for it alone', async () => {
    const passwordRef = { sourceId: 'source-1', entryId: 'entry-1', title: 'web1', username: 'root' };
    const saved = await request('PUT', '/api/folders/settings', {
      path: 'Lab',
      auth: { passwordRef: { ...passwordRef, password: 'must not be stored' } },
    });
    expect(saved.json().folder.auth).toEqual({ passwordRef });
    const cleared = await request('PUT', '/api/folders/settings', { path: 'Lab', auth: {} });
    expect(cleared.json()).toEqual({ folder: null });
  });
});
