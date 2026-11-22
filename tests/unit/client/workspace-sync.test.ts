import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceWindowSync,
  announceWorkspaceCatalogChange,
  openWorkspaceIds,
  type WorkspaceSyncCallbacks,
} from '../../../client/src/workspace-sync.js';

class TestBroadcastChannel {
  static readonly instances = new Set<TestBroadcastChannel>();
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  constructor(readonly name: string) {
    TestBroadcastChannel.instances.add(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    for (const channel of TestBroadcastChannel.instances) {
      if (channel === this || channel.name !== this.name) continue;
      for (const listener of channel.listeners) listener({ data } as MessageEvent);
    }
  }

  close(): void {
    TestBroadcastChannel.instances.delete(this);
    this.listeners.clear();
  }
}

function callbacks() {
  return {
    onCatalogChanged: vi.fn(),
    onOpenWindowCountsChanged: vi.fn(),
    onWindowFocus: vi.fn(),
    onFocusRequested: vi.fn(),
  } satisfies WorkspaceSyncCallbacks;
}

afterEach(() => {
  TestBroadcastChannel.instances.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('workspace window synchronization', () => {
  it('shares catalog invalidations and active-workspace presence', () => {
    vi.useFakeTimers();
    const firstCallbacks = callbacks();
    const secondCallbacks = callbacks();
    const first = new WorkspaceWindowSync(
      new TestBroadcastChannel('workspaces') as unknown as BroadcastChannel,
    );
    const second = new WorkspaceWindowSync(
      new TestBroadcastChannel('workspaces') as unknown as BroadcastChannel,
    );

    first.setActiveWorkspace('operations');
    first.start(firstCallbacks);
    second.setActiveWorkspace('development');
    second.start(secondCallbacks);

    expect(first.openWindowCounts()).toEqual({ development: 1 });
    expect(second.openWindowCounts()).toEqual({ operations: 1 });

    first.invalidateCatalog();
    expect(secondCallbacks.onCatalogChanged).toHaveBeenCalledOnce();

    first.stop();
    second.stop();
  });

  it('focuses one existing owner and removes presence when its window closes', () => {
    vi.useFakeTimers();
    const firstCallbacks = callbacks();
    const secondCallbacks = callbacks();
    const first = new WorkspaceWindowSync(
      new TestBroadcastChannel('workspaces') as unknown as BroadcastChannel,
    );
    const second = new WorkspaceWindowSync(
      new TestBroadcastChannel('workspaces') as unknown as BroadcastChannel,
    );

    first.setActiveWorkspace('operations');
    first.start(firstCallbacks);
    second.setActiveWorkspace('development');
    second.start(secondCallbacks);

    expect(first.focusOpenWorkspace('development')).toBe(true);
    expect(secondCallbacks.onFocusRequested).toHaveBeenCalledOnce();
    expect(first.focusOpenWorkspace('missing')).toBe(false);

    second.stop();
    expect(first.openWindowCounts()).toEqual({});
    expect(firstCallbacks.onOpenWindowCountsChanged).toHaveBeenLastCalledWith({});

    first.stop();
  });
});

describe('asking the windows from outside one', () => {
  /** A renderer with a bus, as a settings window has, and one app window on it. */
  function appWindow(workspaceId: string) {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    const windowCallbacks = callbacks();
    const sync = new WorkspaceWindowSync(
      new TestBroadcastChannel('muxus-workspaces-v1') as unknown as BroadcastChannel,
    );
    sync.setActiveWorkspace(workspaceId);
    sync.start(windowCallbacks);
    return { sync, windowCallbacks };
  }

  it('learns which workspaces are open and leaves no window behind', async () => {
    vi.useFakeTimers();
    const { sync } = appWindow('operations');

    const asked = openWorkspaceIds();
    await vi.advanceTimersByTimeAsync(300);

    expect([...(await asked)]).toEqual(['operations']);
    // Only the app window's own channel is left on the bus.
    expect(TestBroadcastChannel.instances.size).toBe(1);
    sync.stop();
  });

  it('has every window read the list of workspaces again', () => {
    vi.useFakeTimers();
    const { sync, windowCallbacks } = appWindow('operations');

    announceWorkspaceCatalogChange();

    expect(windowCallbacks.onCatalogChanged).toHaveBeenCalledOnce();
    sync.stop();
  });

  it('finds nothing open where there is no window to ask from', async () => {
    await expect(openWorkspaceIds()).resolves.toEqual(new Set());
    expect(() => announceWorkspaceCatalogChange()).not.toThrow();
  });
});
