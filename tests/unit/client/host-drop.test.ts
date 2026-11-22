import { beforeEach, describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import { openDraggedHosts } from '../../../client/src/host-drop.js';
import { managedHostKey } from '../../../client/src/managed-hosts.js';
import { useHostDragStore } from '../../../client/src/state/host-drag.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { panesInOrder, type PaneNode } from '../../../client/src/state/workspace-layout.js';

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    unreadOutputIds: new Set(),
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
    zoomedPaneId: null,
    tiling: null,
  });
  useHostDragStore.setState({ source: null });
});

describe('hosts dropped on a pane', () => {
  it('open in that pane and end tiling, leaving the grid as it is', () => {
    for (const title of ['One', 'Two', 'Three']) {
      useTabsStore.getState().open({ kind: 'local' }, title);
    }
    useTabsStore.getState().arrangeTabs('columns');
    const { root, tabs } = useTabsStore.getState();
    const paneId = tabs[0]!.paneId;
    const router = { kind: 'ssh', entry: { alias: 'router' } as SshHostEntry } as const;
    useHostDragStore.getState().setSource({
      kind: 'host',
      hosts: [{ hostKey: managedHostKey(router), parentKey: '' }],
    });

    openDraggedHosts(paneId, [router]);

    const state = useTabsStore.getState();
    const paneIds = (node: PaneNode) => panesInOrder(node).map((pane) => pane.id);
    expect(state.tiling).toBeNull();
    expect(paneIds(state.root)).toEqual(paneIds(root));
    expect(state.tabs.filter((tab) => tab.paneId === paneId).map((tab) => tab.title)).toEqual([
      'One',
      'router',
    ]);
    expect(useHostDragStore.getState().source).toBeNull();
  });
});
