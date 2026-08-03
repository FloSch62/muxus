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
      error: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
