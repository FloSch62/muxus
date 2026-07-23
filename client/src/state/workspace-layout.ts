import type {
  SessionProfile,
  WorkspaceLayoutV1,
  WorkspaceNode,
} from '@muxus/shared';

export interface PaneLeaf {
  id: string;
  type: 'pane';
  activeTabId: string | null;
}

export interface SplitNode {
  id: string;
  type: 'split';
  direction: 'horizontal' | 'vertical';
  ratio: number;
  children: [PaneNode, PaneNode];
}

export type PaneNode = PaneLeaf | SplitNode;

export interface PersistableTerminalTab {
  id: string;
  paneId: string;
  title: string;
  profile: SessionProfile;
  color?: string;
}

export interface RestoredTerminalTab extends PersistableTerminalTab {
  connectOnMount: false;
}

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlatPaneLayout {
  panes: Array<{ pane: PaneLeaf; rect: LayoutRect }>;
  dividers: Array<{
    splitId: string;
    direction: SplitNode['direction'];
    bounds: LayoutRect;
    ratio: number;
  }>;
}

/** Flatten a nested split tree into stable, absolute pane rectangles. */
export function flattenPaneLayout(root: PaneNode): FlatPaneLayout {
  const result: FlatPaneLayout = { panes: [], dividers: [] };
  const visit = (node: PaneNode, rect: LayoutRect): void => {
    if (node.type === 'pane') {
      result.panes.push({ pane: node, rect });
      return;
    }
    result.dividers.push({
      splitId: node.id,
      direction: node.direction,
      bounds: rect,
      ratio: node.ratio,
    });
    if (node.direction === 'horizontal') {
      const firstWidth = rect.width * node.ratio;
      visit(node.children[0], { ...rect, width: firstWidth });
      visit(node.children[1], {
        ...rect,
        x: rect.x + firstWidth,
        width: rect.width - firstWidth,
      });
    } else {
      const firstHeight = rect.height * node.ratio;
      visit(node.children[0], { ...rect, height: firstHeight });
      visit(node.children[1], {
        ...rect,
        y: rect.y + firstHeight,
        height: rect.height - firstHeight,
      });
    }
  };
  visit(root, { x: 0, y: 0, width: 1, height: 1 });
  return result;
}

export function findPane(root: PaneNode, paneId: string): PaneLeaf | undefined {
  if (root.type === 'pane') return root.id === paneId ? root : undefined;
  return findPane(root.children[0], paneId) ?? findPane(root.children[1], paneId);
}

export function firstPane(root: PaneNode): PaneLeaf {
  return root.type === 'pane' ? root : firstPane(root.children[0]);
}

export function updatePane(
  root: PaneNode,
  paneId: string,
  update: (pane: PaneLeaf) => PaneNode,
): PaneNode {
  if (root.type === 'pane') return root.id === paneId ? update(root) : root;
  const first = updatePane(root.children[0], paneId, update);
  const second = updatePane(root.children[1], paneId, update);
  return first === root.children[0] && second === root.children[1]
    ? root
    : { ...root, children: [first, second] };
}

export function updateSplitRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  if (root.type === 'pane') return root;
  if (root.id === splitId) return { ...root, ratio: clampRatio(ratio) };
  const first = updateSplitRatio(root.children[0], splitId, ratio);
  const second = updateSplitRatio(root.children[1], splitId, ratio);
  return first === root.children[0] && second === root.children[1]
    ? root
    : { ...root, children: [first, second] };
}

/** Remove an empty pane and collapse its parent split around the sibling. */
export function removePane(root: PaneNode, paneId: string): PaneNode | undefined {
  if (root.type === 'pane') return root.id === paneId ? undefined : root;
  const first = removePane(root.children[0], paneId);
  const second = removePane(root.children[1], paneId);
  if (!first) return second;
  if (!second) return first;
  return first === root.children[0] && second === root.children[1]
    ? root
    : { ...root, children: [first, second] };
}

export function serializeWorkspace(
  root: PaneNode,
  tabs: readonly PersistableTerminalTab[],
  activePaneId: string,
): WorkspaceLayoutV1 {
  const byPane = new Map<string, PersistableTerminalTab[]>();
  for (const tab of tabs) {
    const list = byPane.get(tab.paneId) ?? [];
    list.push(tab);
    byPane.set(tab.paneId, list);
  }
  const serializeNode = (node: PaneNode): WorkspaceNode => {
    if (node.type === 'split') {
      return {
        ...node,
        children: [serializeNode(node.children[0]), serializeNode(node.children[1])],
      };
    }
    const paneTabs = byPane.get(node.id) ?? [];
    const activeTabId = paneTabs.some((tab) => tab.id === node.activeTabId)
      ? (node.activeTabId ?? undefined)
      : paneTabs[0]?.id;
    return {
      id: node.id,
      type: 'pane',
      tabs: paneTabs.map((tab) => ({
        id: tab.id,
        kind: 'terminal',
        title: tab.title,
        profile: tab.profile,
        cwdHint: tab.profile.kind === 'local' ? tab.profile.cwd : undefined,
        color: tab.color,
        offerReconnect: true,
      })),
      activeTabId,
    };
  };
  return { version: 1, root: serializeNode(root), activePaneId };
}

export function restoreWorkspace(
  layout: WorkspaceLayoutV1,
): {
  root: PaneNode;
  tabs: RestoredTerminalTab[];
  activePaneId: string;
  activeId: string | null;
} | undefined {
  if (!layout.root) return undefined;
  const tabs: RestoredTerminalTab[] = [];
  const restoreNode = (node: WorkspaceNode): PaneNode => {
    if (node.type === 'split') {
      return {
        id: node.id,
        type: 'split',
        direction: node.direction,
        ratio: clampRatio(node.ratio),
        children: [restoreNode(node.children[0]), restoreNode(node.children[1])],
      };
    }
    const terminalTabs = node.tabs.filter((tab) => tab.kind === 'terminal');
    for (const tab of terminalTabs) {
      // Workspaces written before TERM became fixed may still carry an
      // override. Strip it at the restore boundary and persist the clean
      // profile on the next workspace save.
      const profile = stripLegacyTerm(tab.profile);
      tabs.push({
        id: tab.id,
        paneId: node.id,
        title: tab.title,
        profile,
        color: tab.color,
        connectOnMount: false,
      });
    }
    const activeTabId =
      terminalTabs.some((tab) => tab.id === node.activeTabId)
        ? (node.activeTabId ?? null)
        : (terminalTabs[0]?.id ?? null);
    return { id: node.id, type: 'pane', activeTabId };
  };
  const root = restoreNode(layout.root);
  const requestedPane = layout.activePaneId
    ? findPane(root, layout.activePaneId)
    : undefined;
  const activePane = requestedPane ?? firstPane(root);
  return {
    root,
    tabs,
    activePaneId: activePane.id,
    activeId: activePane.activeTabId,
  };
}

function stripLegacyTerm(profile: SessionProfile): SessionProfile {
  if (!('term' in profile)) return profile;
  const { term: _term, ...clean } = profile;
  return clean as SessionProfile;
}

function clampRatio(ratio: number): number {
  return Math.min(0.9, Math.max(0.1, ratio));
}
