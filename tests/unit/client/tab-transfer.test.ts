import { afterEach, describe, expect, it, vi } from 'vitest';

class TestBroadcastChannel {
  static readonly instances = new Set<TestBroadcastChannel>();
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  constructor(readonly name: string) {
    TestBroadcastChannel.instances.add(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  postMessage(data: unknown): void {
    for (const channel of TestBroadcastChannel.instances) {
      if (channel === this || channel.name !== this.name) continue;
      queueMicrotask(() => {
        for (const listener of channel.listeners) listener({ data } as MessageEvent);
      });
    }
  }
}

class TestDataTransfer {
  private readonly values = new Map<string, string>();

  get types(): string[] {
    return [...this.values.keys()];
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }

  clearData(type?: string): void {
    if (type === undefined) this.values.clear();
    else this.values.delete(type);
  }

  getData(type: string): string {
    return this.values.get(type) ?? '';
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  TestBroadcastChannel.instances.clear();
});

describe('cross-window tab transfer', () => {
  it('adopts a live tab where it is dropped, keeps pinned tabs first and ends tiling', async () => {
    vi.resetModules();
    const transfer = await import('../../../client/src/tab-transfer.js');
    const { useTabsStore } = await import('../../../client/src/state/tabs.js');
    useTabsStore.setState({
      tabs: [],
      unreadOutputIds: new Set(),
      root: { id: 'pane-test', type: 'pane', activeTabId: null },
      activePaneId: 'pane-test',
      activeId: null,
      zoomedPaneId: null,
      tiling: 'columns',
    });
    const existingId = useTabsStore.getState().open({ kind: 'local' }, 'Existing');
    const incoming = {
      id: 'tab-from-window',
      title: 'Router',
      profile: { kind: 'ssh' as const, target: 'router' },
      status: 'connected' as const,
      connectOnMount: true as const,
      terminalId: 'terminal-live',
      transferId: 'transfer-live',
      pinned: true,
      searchRequest: 0,
      editorPaths: [],
      loggingPaused: false,
      captureInput: false,
      reconnectRequest: 0,
    };

    expect(transfer.adoptTransferredTab(incoming, 'pane-test', existingId, 'after')).toBe(true);

    const state = useTabsStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(['tab-from-window', existingId]);
    expect(state.tabs[0]).toMatchObject({ paneId: 'pane-test', pinned: true });
    expect(state).toMatchObject({ activeId: 'tab-from-window', tiling: null });
    expect(transfer.adoptTransferredTab(incoming, 'pane-test')).toBe(false);
  });

  it('joins a host monitor arriving from another window with the one already here', async () => {
    vi.resetModules();
    const transfer = await import('../../../client/src/tab-transfer.js');
    const { useTabsStore } = await import('../../../client/src/state/tabs.js');
    useTabsStore.setState({
      tabs: [],
      unreadOutputIds: new Set(),
      root: { id: 'pane-test', type: 'pane', activeTabId: null },
      activePaneId: 'pane-test',
      activeId: null,
      zoomedPaneId: null,
    });
    const incoming = {
      id: 'monitor-from-window',
      title: 'Host monitor',
      profile: null,
      status: 'idle' as const,
      connectOnMount: false as const,
      view: 'monitor' as const,
      searchRequest: 0,
      editorPaths: [],
      loggingPaused: false,
      captureInput: false,
      reconnectRequest: 0,
    };

    // A window without a monitor takes the tab as it is.
    expect(transfer.adoptTransferredTab(incoming, 'pane-test')).toBe(true);
    expect(useTabsStore.getState().tabs).toMatchObject([{ id: 'monitor-from-window', view: 'monitor' }]);

    // A window that has one keeps a single monitor and shows it.
    const sessionId = useTabsStore.getState().open({ kind: 'local' }, 'Shell');
    expect(useTabsStore.getState().activeId).toBe(sessionId);
    expect(transfer.adoptTransferredTab({ ...incoming, id: 'second-monitor' }, 'pane-test')).toBe(true);
    const state = useTabsStore.getState();
    expect(state.tabs.filter((tab) => tab.view === 'monitor')).toHaveLength(1);
    expect(state.activeId).toBe('monitor-from-window');

    // Another view is no duplicate of the monitor: the hosts tab arrives beside it.
    const hosts = { ...incoming, id: 'hosts-from-window', title: 'Hosts', view: 'hosts' as const };
    expect(transfer.adoptTransferredTab(hosts, 'pane-test')).toBe(true);
    expect(transfer.adoptTransferredTab({ ...hosts, id: 'second-hosts' }, 'pane-test')).toBe(true);
    const views = useTabsStore.getState().tabs.flatMap((tab) => tab.view ?? []);
    expect(views.toSorted()).toEqual(['hosts', 'monitor']);
    expect(useTabsStore.getState().activeId).toBe('hosts-from-window');
  });

  it('transfers an interrupted live tab and removes the source only after completion', async () => {
    vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    vi.resetModules();
    const source = await import('../../../client/src/tab-transfer.js');
    vi.resetModules();
    const destination = await import('../../../client/src/tab-transfer.js');
    const { useTabsStore } = await import('../../../client/src/state/tabs.js');
    useTabsStore.setState({
      tabs: [],
      unreadOutputIds: new Set(),
      root: { id: 'pane-test', type: 'pane', activeTabId: null },
      activePaneId: 'pane-test',
      activeId: null,
      zoomedPaneId: null,
    });
    const complete = vi.fn();
    const tab = {
      id: 'tab-live',
      title: 'Router',
      profile: { kind: 'ssh' as const, target: 'router' },
      status: 'interrupted' as const,
      connectOnMount: true as const,
      terminalId: 'terminal-live',
      searchRequest: 0,
      editorPaths: [],
      loggingPaused: false,
      captureInput: false,
      reconnectRequest: 0,
    };
    const transferId = 'opaque-live-token';
    source.registerTabTransferSourceOptions(transferId, {
      tabId: tab.id,
      prepare: vi.fn(async () => true),
      snapshot: () => tab,
      cancel: vi.fn(),
      complete,
    });

    await destination.receiveTabTransfer(transferId, 'pane-test');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      id: tab.id,
      status: 'interrupted',
      connectOnMount: true,
      transferId,
    });
    expect(complete).not.toHaveBeenCalled();

    destination.completeTabTransfer(transferId);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
  });

  it('puts only the opaque transfer token in the drag payload', async () => {
    vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    vi.resetModules();
    const transfer = await import('../../../client/src/tab-drag.js');
    const data = new TestDataTransfer();
    data.setData('text/plain', 'Router');

    transfer.writeTabTransfer(data as never, 'opaque-token');

    expect(transfer.hasTabTransfer(data as never)).toBe(true);
    expect(transfer.readTabTransfer(data as never)).toBe('opaque-token');
    expect(data.getData(transfer.TAB_TRANSFER_MIME)).toBe('opaque-token');
    expect(data.getData('text/plain')).toBe('');
    expect(data.types).toEqual([transfer.TAB_TRANSFER_MIME]);
  });

  it('detaches rejected drops only when they end outside the source window', async () => {
    vi.resetModules();
    const { shouldDetachTabDrag } = await import('../../../client/src/tab-drag.js');
    const bounds = { screenX: 100, screenY: 50, outerWidth: 800, outerHeight: 600 };
    const event = (screenX: number, screenY: number, dropEffect = 'none') => ({
      dataTransfer: { dropEffect },
      screenX,
      screenY,
    });

    expect(shouldDetachTabDrag(event(99, 300) as never, bounds)).toBe(true);
    expect(shouldDetachTabDrag(event(900, 300) as never, bounds)).toBe(true);
    expect(shouldDetachTabDrag(event(400, 650) as never, bounds)).toBe(true);
    expect(shouldDetachTabDrag(event(400, 300) as never, bounds)).toBe(false);
    expect(shouldDetachTabDrag(event(950, 300, 'move') as never, bounds)).toBe(false);
  });
});
