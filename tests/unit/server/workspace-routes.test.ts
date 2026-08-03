import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'workspace-test-token';
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

function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}

const layout = {
  version: 1,
  root: {
    id: 'split-1',
    type: 'split',
    direction: 'horizontal',
    ratio: 0.55,
    children: [
      {
        id: 'pane-1',
        type: 'pane',
        activeTabId: 'terminal-1',
        tabs: [
          {
            id: 'terminal-1',
            kind: 'terminal',
            title: 'Production',
            profile: { kind: 'ssh', target: 'production' },
            cwdHint: '/srv/app',
            pinned: true,
            offerReconnect: true,
          },
        ],
      },
      {
        id: 'pane-2',
        type: 'pane',
        activeTabId: 'sftp-1',
        tabs: [
          {
            id: 'sftp-1',
            kind: 'sftp',
            title: 'Logs',
            connection: { source: 'openssh', id: 'production' },
            path: '/var/log',
          },
        ],
      },
    ],
  },
  activePaneId: 'pane-1',
} as const;

describe('workspace routes', () => {
  it('requires the per-run API credential', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/workspaces' });
    expect(response.statusCode).toBe(401);
  });

  it('round-trips a versioned pane tree without claiming to resume sessions', async () => {
    const save = await app.inject({
      method: 'PUT',
      url: '/api/workspaces',
      headers: auth(),
      payload: { name: 'Daily work', layout },
    });
    expect(save.statusCode).toBe(200);
    const saved = save.json();

    const read = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${saved.id}`,
      headers: auth(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      id: saved.id,
      name: 'Daily work',
      layout,
      multiExecGroups: [],
      isStartup: false,
    });

    const list = await app.inject({ method: 'GET', url: '/api/workspaces', headers: auth() });
    expect(list.json().workspaces).toEqual([
      expect.objectContaining({ id: saved.id, name: 'Daily work' }),
    ]);
    expect(list.json().workspaces[0]).not.toHaveProperty('layout');

    const latest = await app.inject({
      method: 'GET',
      url: '/api/workspaces/latest',
      headers: auth(),
    });
    expect(latest.json()).toEqual({
      workspace: expect.objectContaining({ id: saved.id, name: 'Daily work', layout }),
    });
  });

  it('renames, opens, and configures a startup workspace', async () => {
    const save = await app.inject({
      method: 'PUT',
      url: '/api/workspaces',
      headers: auth(),
      payload: {
        name: 'Daily work',
        layout: {
          ...layout,
          root: {
            ...layout.root,
            children: [
              {
                ...layout.root.children[0],
                tabs: [
                  ...layout.root.children[0].tabs,
                  {
                    id: 'terminal-2',
                    kind: 'terminal',
                    title: 'Staging',
                    profile: { kind: 'ssh', target: 'staging' },
                    offerReconnect: true,
                  },
                ],
              },
              layout.root.children[1],
            ],
          },
        },
        multiExecGroups: [
          { id: 'routers', name: 'Routers', tabIds: ['terminal-1', 'terminal-2'] },
        ],
      },
    });
    const id = save.json().id as string;

    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${id}`,
      headers: auth(),
      payload: { name: 'Operations' },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({
      name: 'Operations',
      multiExecGroups: [{ id: 'routers', name: 'Routers' }],
    });

    const startup = await app.inject({
      method: 'PUT',
      url: '/api/workspaces/startup',
      headers: auth(),
      payload: { id },
    });
    expect(startup.statusCode).toBe(200);
    expect(startup.json().workspace).toMatchObject({ id, isStartup: true });

    const open = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${id}/open`,
      headers: auth(),
    });
    expect(open.statusCode).toBe(200);
    expect(open.json().lastOpenedAt).toBeDefined();

    const readStartup = await app.inject({
      method: 'GET',
      url: '/api/workspaces/startup',
      headers: auth(),
    });
    expect(readStartup.json().workspace).toMatchObject({ id, name: 'Operations' });
  });

  it('deletes a workspace and clears its startup selection', async () => {
    const save = await app.inject({
      method: 'PUT',
      url: '/api/workspaces',
      headers: auth(),
      payload: { name: 'Temporary', layout },
    });
    const id = save.json().id as string;
    await app.inject({
      method: 'PUT',
      url: '/api/workspaces/startup',
      headers: auth(),
      payload: { id },
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${id}`,
      headers: auth(),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    const read = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${id}`,
      headers: auth(),
    });
    expect(read.statusCode).toBe(404);

    const startup = await app.inject({
      method: 'GET',
      url: '/api/workspaces/startup',
      headers: auth(),
    });
    expect(startup.json()).toEqual({ workspace: null });
  });

  it('returns null when there is no latest workspace', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspaces/latest',
      headers: auth(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ workspace: null });
  });

  it('rejects invalid split dimensions', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/workspaces',
      headers: auth(),
      payload: {
        name: 'Broken',
        layout: {
          ...layout,
          root: { ...layout.root, ratio: 0.99 },
        },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects multi-exec groups with dangling terminal references', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/workspaces',
      headers: auth(),
      payload: {
        name: 'Broken group',
        layout,
        multiExecGroups: [
          { id: 'routers', name: 'Routers', tabIds: ['terminal-1', 'missing'] },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/unknown terminal tab/);
  });

  it('rejects ambiguous or dangling workspace identifiers', async () => {
    const duplicate = {
      ...layout,
      root: {
        ...layout.root,
        children: [
          layout.root.children[0],
          { ...layout.root.children[1], id: layout.root.children[0].id },
        ],
      },
    };
    const duplicateResponse = await app.inject({
      method: 'PUT',
      url: '/api/workspaces',
      headers: auth(),
      payload: { name: 'Duplicate panes', layout: duplicate },
    });
    expect(duplicateResponse.statusCode).toBe(400);
    expect(duplicateResponse.json().message).toMatch(/duplicate workspace node id/);

    const dangling = { ...layout, activePaneId: 'missing-pane' };
    const danglingResponse = await app.inject({
      method: 'PUT',
      url: '/api/workspaces',
      headers: auth(),
      payload: { name: 'Dangling focus', layout: dangling },
    });
    expect(danglingResponse.statusCode).toBe(400);
    expect(danglingResponse.json().message).toMatch(/active pane.*does not exist/);
  });
});
