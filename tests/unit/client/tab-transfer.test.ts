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

  getData(type: string): string {
    return this.values.get(type) ?? '';
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  TestBroadcastChannel.instances.clear();
});

describe('cross-window tab transfer', () => {
  it('adopts a live tab and keeps pinned tabs first', async () => {
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
      sftpOpen: false,
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
    expect(state.activeId).toBe('tab-from-window');
    expect(transfer.adoptTransferredTab(incoming, 'pane-test')).toBe(false);
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
      sftpOpen: false,
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

    transfer.writeTabTransfer(data as never, 'opaque-token');

    expect(transfer.hasTabTransfer(data as never)).toBe(true);
    expect(transfer.readTabTransfer(data as never)).toBe('opaque-token');
    expect(data.getData(transfer.TAB_TRANSFER_MIME)).toBe('opaque-token');
    expect(data.getData('text/plain')).toBe('muxus-tab:opaque-token');
  });
});
