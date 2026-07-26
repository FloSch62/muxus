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

/** Where a new pane goes, or which neighbour to look for. */
export type PaneDirection = 'left' | 'right' | 'up' | 'down';

export const PANE_DIRECTIONS: readonly PaneDirection[] = ['left', 'right', 'up', 'down'];

/** Horizontal splits stack left/right; vertical splits stack top/bottom. */
export function splitAxis(direction: PaneDirection): SplitNode['direction'] {
  return direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
}

/** Left/up place the new pane before the existing one. */
export function placesPaneFirst(direction: PaneDirection): boolean {
  return direction === 'left' || direction === 'up';
}

export interface PersistableTerminalTab {
  id: string;
  paneId: string;
  title: string;
  profile: SessionProfile;
  color?: string;
}

export interface RestoredTerminalTab extends PersistableTerminalTab {
  /** Local shells start fresh immediately; remote sessions dial only when the restore opts in. */
  connectOnMount: boolean;
}

export interface RestoreWorkspaceOptions {
  /** Dial restored remote sessions instead of waiting for a key press. */
  connectRemote?: boolean;
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

export function containsPane(root: PaneNode, paneId: string): boolean {
  return findPane(root, paneId) !== undefined;
}

export function firstPane(root: PaneNode): PaneLeaf {
  return root.type === 'pane' ? root : firstPane(root.children[0]);
}

/** Panes in visual reading order — the order keyboard cycling follows. */
export function panesInOrder(root: PaneNode): PaneLeaf[] {
  if (root.type === 'pane') return [root];
  return [...panesInOrder(root.children[0]), ...panesInOrder(root.children[1])];
}

export function countPanes(root: PaneNode): number {
  return root.type === 'pane' ? 1 : countPanes(root.children[0]) + countPanes(root.children[1]);
}

/** Splits from the root down to a pane, with the branch each one descends. */
export function splitPath(root: PaneNode, paneId: string): Array<{ split: SplitNode; branch: 0 | 1 }> {
  if (root.type === 'pane') return [];
  for (const branch of [0, 1] as const) {
    const child = root.children[branch];
    if (!containsPane(child, paneId)) continue;
    return [{ split: root, branch }, ...splitPath(child, paneId)];
  }
  return [];
}

/** The split a pane shares with its closest sibling subtree. */
export function parentSplit(
  root: PaneNode,
  paneId: string,
): { split: SplitNode; branch: 0 | 1 } | undefined {
  return splitPath(root, paneId).at(-1);
}

/**
 * The pane a directional move lands on, chosen by geometry rather than tree
 * shape: candidates must sit on that side and overlap the source pane across
 * the movement axis; the nearest one wins, then the one sharing the most edge.
 */
export function neighborPaneId(
  root: PaneNode,
  paneId: string,
  direction: PaneDirection,
): string | undefined {
  const epsilon = 1e-6;
  const { panes } = flattenPaneLayout(root);
  const source = panes.find((entry) => entry.pane.id === paneId);
  if (!source) return undefined;
  const horizontal = splitAxis(direction) === 'horizontal';
  const forward = direction === 'right' || direction === 'down';
  const span = (rect: LayoutRect) =>
    horizontal
      ? { start: rect.x, end: rect.x + rect.width, crossStart: rect.y, crossEnd: rect.y + rect.height }
      : { start: rect.y, end: rect.y + rect.height, crossStart: rect.x, crossEnd: rect.x + rect.width };
  const from = span(source.rect);

  let bestId: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of panes) {
    if (candidate.pane.id === paneId) continue;
    const to = span(candidate.rect);
    const gap = forward ? to.start - from.end : from.start - to.end;
    if (gap < -epsilon) continue;
    const overlap =
      Math.min(from.crossEnd, to.crossEnd) - Math.max(from.crossStart, to.crossStart);
    if (overlap <= epsilon) continue;
    const score = gap * 1_000 - overlap;
    if (score < bestScore) {
      bestScore = score;
      bestId = candidate.pane.id;
    }
  }
  return bestId;
}

/** Give every pane an equal share of the canvas along its split axis. */
export function equalizeSplits(root: PaneNode): PaneNode {
  if (root.type === 'pane') return root;
  const first = equalizeSplits(root.children[0]);
  const second = equalizeSplits(root.children[1]);
  const ratio = clampRatio(countPanes(first) / (countPanes(first) + countPanes(second)));
  return first === root.children[0] && second === root.children[1] && ratio === root.ratio
    ? root
    : { ...root, ratio, children: [first, second] };
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
  options?: RestoreWorkspaceOptions,
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
        connectOnMount:
          profile.kind === 'local' || (options?.connectRemote === true && tab.offerReconnect),
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
