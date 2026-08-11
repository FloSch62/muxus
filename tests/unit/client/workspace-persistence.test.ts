import type { WorkspaceRecord, WorkspaceSummary } from '@muxus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRuntime } from '../../../client/src/workspace-persistence.js';
import { useMultiExecStore } from '../../../client/src/state/multi-exec.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { useWorkspacesStore } from '../../../client/src/state/workspaces.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function summaryOf(workspace: WorkspaceRecord): WorkspaceSummary {
  const { layout: _layout, multiExecGroups: _groups, ...summary } = workspace;
  return summary;
}

describe('workspace persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTabsStore.setState({
      tabs: [],
      unreadOutputIds: new Set(),
      root: { id: 'pane-test', type: 'pane', activeTabId: null },
      activePaneId: 'pane-test',
      activeId: null,
      zoomedPaneId: null,
    });
    useMultiExecStore.setState({ selectedIds: [], lastMirroredIds: [], groups: [] });
    useWorkspacesStore.setState({
      workspaces: [],
      activeId: undefined,
      activeName: 'Unsaved workspace',
      startupId: undefined,
      ready: false,
      busy: false,
      openWindowCounts: {},
      error: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps a secondary session window unsaved instead of loading the startup workspace', async () => {
    const sessionId = useTabsStore.getState().open({ kind: 'local' }, 'Independent shell');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (path === '/api/workspaces' && (init?.method ?? 'GET') === 'GET') {
        return json({ workspaces: [] });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = new WorkspaceRuntime({ kind: 'blank' });
    await runtime.start();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useWorkspacesStore.getState()).toMatchObject({
      activeId: undefined,
      activeName: 'Unsaved workspace',
      ready: true,
    });
    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: sessionId, title: 'Independent shell' }),
    ]);

    runtime.stop();
  });

  it('uses the next free workspace name when an unsaved window is automatically saved', async () => {
    const existing: WorkspaceRecord = {
      id: 'existing-default',
      name: 'Workspace 1',
      layout: { version: 1, root: null },
      multiExecGroups: [],
      isLocked: false,
      isStartup: false,
      createdAt: '2026-08-11T08:00:00Z',
      updatedAt: '2026-08-11T08:00:00Z',
    };
    let created: WorkspaceRecord | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/workspaces' && method === 'GET') {
        return json({ workspaces: [summaryOf(existing)] });
      }
      if (path === '/api/workspaces' && method === 'PUT') {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        const saved = JSON.parse(init.body) as Pick<
          WorkspaceRecord,
          'name' | 'layout' | 'multiExecGroups'
        >;
        created = {
          ...saved,
          id: 'new-default',
          isLocked: false,
          isStartup: false,
          createdAt: '2026-08-11T08:05:00Z',
          updatedAt: '2026-08-11T08:05:00Z',
        };
        return json(created);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = new WorkspaceRuntime({ kind: 'blank' });
    await runtime.start();

    useTabsStore.getState().open({ kind: 'local' }, 'Transferred session');
    await vi.advanceTimersByTimeAsync(400);

    expect(created).toMatchObject({ name: 'Workspace 2' });
    expect(useWorkspacesStore.getState()).toMatchObject({
      activeId: 'new-default',
      activeName: 'Workspace 2',
    });

    runtime.stop();
  });

  it('creates a named empty workspace for a new workspace window', async () => {
    let created: WorkspaceRecord | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/workspaces' && method === 'GET') {
        return json({ workspaces: [] });
      }
      if (path === '/api/workspaces' && method === 'PUT') {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        const inputWorkspace = JSON.parse(init.body) as Pick<
          WorkspaceRecord,
          'id' | 'name' | 'layout' | 'multiExecGroups'
        > & { createIfMissing: boolean };
        created = {
          id: inputWorkspace.id,
          name: inputWorkspace.name,
          layout: inputWorkspace.layout,
          multiExecGroups: inputWorkspace.multiExecGroups,
          isLocked: false,
          isStartup: false,
          createdAt: '2026-08-05T20:00:00Z',
          updatedAt: '2026-08-05T20:00:00Z',
        };
        return json(created);
      }
      if (path === '/api/workspaces/new-window-workspace/open' && method === 'POST') {
        return json(created);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = new WorkspaceRuntime({
      kind: 'new',
      id: 'new-window-workspace',
      name: 'Production EU',
    });
    await runtime.start();

    expect(created).toMatchObject({
      id: 'new-window-workspace',
      name: 'Production EU',
      layout: {
        version: 1,
        root: { type: 'pane', tabs: [] },
      },
      multiExecGroups: [],
    });
    const createRequest = fetchMock.mock.calls.find(
      ([path, init]) => path === '/api/workspaces' && init?.method === 'PUT',
    );
    expect(JSON.parse(createRequest?.[1]?.body as string)).toMatchObject({
      id: 'new-window-workspace',
      createIfMissing: true,
    });
    expect(useWorkspacesStore.getState()).toMatchObject({
      activeId: 'new-window-workspace',
      activeName: 'Production EU',
      ready: true,
    });

    runtime.stop();
  });

  it('restores a locked workspace after one of its sessions was closed', async () => {
    const persisted: WorkspaceRecord = {
      id: 'locked-operations',
      name: 'Locked operations',
      layout: {
        version: 1,
        root: {
          id: 'pane-operations',
          type: 'pane',
          activeTabId: 'saved-shell',
          tabs: [
            {
              id: 'saved-shell',
              kind: 'terminal',
              title: 'Saved shell',
              profile: { kind: 'local' },
              offerReconnect: true,
            },
          ],
        },
        activePaneId: 'pane-operations',
      },
      multiExecGroups: [],
      isLocked: true,
      isStartup: false,
      createdAt: '2026-08-05T20:00:00Z',
      updatedAt: '2026-08-05T20:00:00Z',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/workspaces' && method === 'GET') {
        return json({ workspaces: [summaryOf(persisted)] });
      }
      if (path === `/api/workspaces/${persisted.id}` && method === 'GET') {
        return json(persisted);
      }
      if (path === `/api/workspaces/${persisted.id}/open` && method === 'POST') {
        return json(persisted);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkspaceRuntime({ kind: 'open', id: persisted.id });
    await runtime.start();

    useTabsStore.getState().close('saved-shell');
    expect(useTabsStore.getState().tabs).toEqual([]);

    await runtime.open(persisted.id);
    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: 'saved-shell', title: 'Saved shell' }),
    ]);

    runtime.stop();
  });

  it('reconciles remote renames, locks, and deletions without closing live sessions', async () => {
    let persisted: WorkspaceRecord | undefined = {
      id: 'shared-operations',
      name: 'Shared operations',
      layout: {
        version: 1,
        root: {
          id: 'pane-shared',
          type: 'pane',
          activeTabId: 'shared-shell',
          tabs: [
            {
              id: 'shared-shell',
              kind: 'terminal',
              title: 'Shared shell',
              profile: { kind: 'local' },
              offerReconnect: true,
            },
          ],
        },
      },
      multiExecGroups: [],
      isLocked: false,
      isStartup: false,
      createdAt: '2026-08-05T20:00:00Z',
      updatedAt: '2026-08-05T20:00:00Z',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/workspaces' && method === 'GET') {
        return json({ workspaces: persisted ? [summaryOf(persisted)] : [] });
      }
      if (path === '/api/workspaces/shared-operations' && method === 'GET' && persisted) {
        return json(persisted);
      }
      if (path === '/api/workspaces/shared-operations/open' && method === 'POST' && persisted) {
        return json(persisted);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkspaceRuntime({ kind: 'open', id: 'shared-operations' });
    await runtime.start();

    persisted = { ...persisted!, name: 'Renamed elsewhere', isLocked: true };
    await runtime.refreshCatalog();
    expect(useWorkspacesStore.getState()).toMatchObject({
      activeId: 'shared-operations',
      activeName: 'Renamed elsewhere',
      workspaces: [expect.objectContaining({ isLocked: true })],
    });

    persisted = undefined;
    await runtime.refreshCatalog();
    expect(useWorkspacesStore.getState()).toMatchObject({
      activeId: undefined,
      activeName: 'Unsaved workspace',
      error: expect.stringContaining('deleted in another window'),
    });
    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: 'shared-shell', title: 'Shared shell' }),
    ]);

    runtime.stop();
  });

  it('only updates a locked workspace explicitly and resumes auto-save after unlock', async () => {
    let persisted: WorkspaceRecord = {
      id: 'stable-startup',
      name: 'Stable startup',
      layout: { version: 1, root: null },
      multiExecGroups: [],
      isLocked: true,
      isStartup: true,
      createdAt: '2026-08-03T12:00:00Z',
      updatedAt: '2026-08-03T12:00:00Z',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/workspaces' && method === 'GET') {
        return json({ workspaces: [summaryOf(persisted)] });
      }
      if (path === '/api/workspaces/startup') return json({ workspace: persisted });
      if (path === '/api/workspaces/latest') return json({ workspace: persisted });
      if (path === `/api/workspaces/${persisted.id}/open`) return json(persisted);
      if (path === `/api/workspaces/${persisted.id}` && method === 'PATCH') {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        const patch = JSON.parse(init.body) as { isLocked: boolean };
        persisted = { ...persisted, ...patch };
        return json(persisted);
      }
      if (path === '/api/workspaces' && method === 'PUT') {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        const update = JSON.parse(init.body) as Pick<
          WorkspaceRecord,
          'layout' | 'multiExecGroups'
        >;
        persisted = { ...persisted, ...update };
        return json(persisted);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkspaceRuntime();
    await runtime.start();

    useTabsStore.getState().open({ kind: 'local' }, 'First');
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/workspaces',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(runtime.flushOnUnload()).toBe(0);

    await runtime.save();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces',
      expect.objectContaining({ method: 'PUT' }),
    );
    const explicitBody = JSON.parse(
      fetchMock.mock.calls.find(
        ([path, init]) => path === '/api/workspaces' && init?.method === 'PUT',
      )![1]!.body as string,
    ) as Record<string, unknown>;
    expect(explicitBody.overwriteLocked).toBe(true);
    expect(persisted.layout.root).not.toBeNull();

    useTabsStore.getState().open({ kind: 'local' }, 'Second');
    await vi.advanceTimersByTimeAsync(400);
    const savesBeforeUnlock = fetchMock.mock.calls.filter(
      ([path, init]) => path === '/api/workspaces' && init?.method === 'PUT',
    ).length;
    expect(savesBeforeUnlock).toBe(1);

    await runtime.setLocked(persisted.id, false);
    await vi.advanceTimersByTimeAsync(400);
    const savesAfterUnlock = fetchMock.mock.calls.filter(
      ([path, init]) => path === '/api/workspaces' && init?.method === 'PUT',
    ).length;
    expect(savesAfterUnlock).toBe(2);
    expect(persisted.isLocked).toBe(false);

    runtime.stop();
  });

  it('coalesces a pending automatic update into one explicit save', async () => {
    let persisted: WorkspaceRecord = {
      id: 'daily',
      name: 'Daily',
      layout: { version: 1, root: null },
      multiExecGroups: [],
      isLocked: false,
      isStartup: true,
      createdAt: '2026-08-03T12:00:00Z',
      updatedAt: '2026-08-03T12:00:00Z',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/workspaces' && method === 'GET') {
        return json({ workspaces: [summaryOf(persisted)] });
      }
      if (path === '/api/workspaces/startup' || path === '/api/workspaces/latest') {
        return json({ workspace: persisted });
      }
      if (path === `/api/workspaces/${persisted.id}/open`) return json(persisted);
      if (path === '/api/workspaces' && method === 'PUT') {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        const update = JSON.parse(init.body) as Pick<
          WorkspaceRecord,
          'layout' | 'multiExecGroups'
        >;
        persisted = { ...persisted, ...update };
        return json(persisted);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkspaceRuntime();
    await runtime.start();
    await vi.advanceTimersByTimeAsync(400);
    fetchMock.mockClear();

    useTabsStore.getState().open({ kind: 'local' }, 'Pending change');
    await runtime.save();
    await vi.advanceTimersByTimeAsync(400);

    const saves = fetchMock.mock.calls.filter(
      ([path, init]) => path === '/api/workspaces' && init?.method === 'PUT',
    );
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0]![1]!.body as string)).toMatchObject({
      id: persisted.id,
      overwriteLocked: true,
    });

    runtime.stop();
  });

  it('detaches instead of recreating a workspace deleted before an autosave lands', async () => {
    const persisted: WorkspaceRecord = {
      id: 'deleted-remotely',
      name: 'Deleted remotely',
      layout: { version: 1, root: null },
      multiExecGroups: [],
      isLocked: false,
      isStartup: true,
      createdAt: '2026-08-03T12:00:00Z',
      updatedAt: '2026-08-03T12:00:00Z',
    };
    let deleted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/workspaces' && method === 'GET') {
        return json({ workspaces: deleted ? [] : [summaryOf(persisted)] });
      }
      if (path === '/api/workspaces/startup' || path === '/api/workspaces/latest') {
        return json({ workspace: persisted });
      }
      if (path === `/api/workspaces/${persisted.id}/open`) return json(persisted);
      if (path === '/api/workspaces' && method === 'PUT') {
        return deleted
          ? json({ message: 'workspace not found', code: 'workspace-not-found' }, 404)
          : json(persisted);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkspaceRuntime();
    await runtime.start();
    await vi.advanceTimersByTimeAsync(400);
    fetchMock.mockClear();
    deleted = true;

    useTabsStore.getState().open({ kind: 'local' }, 'Unsaved after delete');
    await vi.advanceTimersByTimeAsync(400);

    expect(useWorkspacesStore.getState()).toMatchObject({
      activeId: undefined,
      activeName: 'Unsaved workspace',
      error: expect.stringContaining('deleted in another window'),
    });
    const failedSaves = fetchMock.mock.calls.filter(
      ([path, init]) => path === '/api/workspaces' && init?.method === 'PUT',
    );
    expect(failedSaves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock.mock.calls.filter(
      ([path, init]) => path === '/api/workspaces' && init?.method === 'PUT',
    )).toHaveLength(1);

    runtime.stop();
  });

  it('requeues a rejected update after another client unlocks the workspace', async () => {
    const persisted: WorkspaceRecord = {
      id: 'shared',
      name: 'Shared',
      layout: { version: 1, root: null },
      multiExecGroups: [],
      isLocked: false,
      isStartup: true,
      createdAt: '2026-08-03T12:00:00Z',
      updatedAt: '2026-08-03T12:00:00Z',
    };
    let rejectSaves = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/workspaces' && method === 'GET') {
        return json({ workspaces: [summaryOf(persisted)] });
      }
      if (path === '/api/workspaces/startup' || path === '/api/workspaces/latest') {
        return json({ workspace: persisted });
      }
      if (path === `/api/workspaces/${persisted.id}/open`) return json(persisted);
      if (path === `/api/workspaces/${persisted.id}` && method === 'PATCH') {
        return json(persisted);
      }
      if (path === '/api/workspaces' && method === 'PUT') {
        return rejectSaves
          ? json({ message: 'workspace is locked', code: 'workspace-locked' }, 409)
          : json(persisted);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkspaceRuntime();
    await runtime.start();
    await vi.advanceTimersByTimeAsync(400);
    fetchMock.mockClear();
    rejectSaves = true;

    useTabsStore.getState().open({ kind: 'local' }, 'Blocked update');
    await vi.advanceTimersByTimeAsync(400);
    expect(useWorkspacesStore.getState().workspaces[0]?.isLocked).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    const rejectedSaves = fetchMock.mock.calls.filter(
      ([path, init]) => path === '/api/workspaces' && init?.method === 'PUT',
    );
    expect(rejectedSaves).toHaveLength(1);

    rejectSaves = false;
    await runtime.setLocked(persisted.id, false);
    await vi.advanceTimersByTimeAsync(400);
    const savesAfterUnlock = fetchMock.mock.calls.filter(
      ([path, init]) => path === '/api/workspaces' && init?.method === 'PUT',
    );
    expect(savesAfterUnlock).toHaveLength(2);
    expect(savesAfterUnlock[1]?.[1]?.body).toBe(rejectedSaves[0]?.[1]?.body);

    runtime.stop();
  });
});
