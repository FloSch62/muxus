import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceWindowSync,
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
