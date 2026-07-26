import { describe, expect, it } from 'vitest';
import {
  containsPane,
  equalizeSplits,
  flattenPaneLayout,
  neighborPaneId,
  panesInOrder,
  parentSplit,
  removePane,
  restoreWorkspace,
  serializeWorkspace,
  updatePane,
  updateSplitRatio,
  type PaneNode,
} from '../../../client/src/state/workspace-layout.js';

const root: PaneNode = {
  id: 'split-root',
  type: 'split',
  direction: 'horizontal',
  ratio: 0.6,
  children: [
    { id: 'pane-left', type: 'pane', activeTabId: 'tab-a' },
    {
      id: 'split-right',
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        { id: 'pane-top', type: 'pane', activeTabId: null },
        { id: 'pane-bottom', type: 'pane', activeTabId: 'tab-b' },
      ],
    },
  ],
};

describe('pane tree operations', () => {
  it('flattens nested splits into stable absolute pane rectangles', () => {
    const flat = flattenPaneLayout(root);
    expect(flat.panes).toEqual([
      {
        pane: expect.objectContaining({ id: 'pane-left' }),
        rect: { x: 0, y: 0, width: 0.6, height: 1 },
      },
      {
        pane: expect.objectContaining({ id: 'pane-top' }),
        rect: { x: 0.6, y: 0, width: 0.4, height: 0.5 },
      },
      {
        pane: expect.objectContaining({ id: 'pane-bottom' }),
        rect: { x: 0.6, y: 0.5, width: 0.4, height: 0.5 },
      },
    ]);
    expect(flat.dividers.map((divider) => divider.splitId)).toEqual(['split-root', 'split-right']);
  });

  it('updates one leaf and clamps divider ratios', () => {
    const activated = updatePane(root, 'pane-top', (pane) => ({ ...pane, activeTabId: 'tab-c' }));
    const resized = updateSplitRatio(activated, 'split-right', 0.99);
    expect(resized).toMatchObject({
      children: [
        {},
        {
          ratio: 0.9,
          children: [{ activeTabId: 'tab-c' }, {}],
        },
      ],
    });
  });

  it('collapses a parent split when an empty pane is removed', () => {
    const withoutTop = removePane(root, 'pane-top');
    expect(withoutTop).toMatchObject({
      id: 'split-root',
      children: [{ id: 'pane-left' }, { id: 'pane-bottom' }],
    });
  });
});

describe('directional pane navigation', () => {
  it('follows what the eye sees rather than the tree shape', () => {
    // pane-left spans the full height, so both right-hand panes border it.
    expect(neighborPaneId(root, 'pane-left', 'right')).toBe('pane-top');
    expect(neighborPaneId(root, 'pane-bottom', 'left')).toBe('pane-left');
    expect(neighborPaneId(root, 'pane-top', 'down')).toBe('pane-bottom');
    expect(neighborPaneId(root, 'pane-bottom', 'up')).toBe('pane-top');
  });

  it('has no neighbour at the edges of the canvas', () => {
    expect(neighborPaneId(root, 'pane-left', 'left')).toBeUndefined();
    expect(neighborPaneId(root, 'pane-left', 'up')).toBeUndefined();
    expect(neighborPaneId(root, 'pane-top', 'right')).toBeUndefined();
    expect(neighborPaneId(root, 'pane-bottom', 'down')).toBeUndefined();
    expect(neighborPaneId(root, 'missing', 'left')).toBeUndefined();
  });

  it('skips panes that only touch at a corner', () => {
    const stacked: PaneNode = {
      id: 'split-root',
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        {
          id: 'split-left',
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          children: [
            { id: 'pane-nw', type: 'pane', activeTabId: null },
            { id: 'pane-sw', type: 'pane', activeTabId: null },
          ],
        },
        {
          id: 'split-right',
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          children: [
            { id: 'pane-ne', type: 'pane', activeTabId: null },
            { id: 'pane-se', type: 'pane', activeTabId: null },
          ],
        },
      ],
    };
    expect(neighborPaneId(stacked, 'pane-nw', 'right')).toBe('pane-ne');
    expect(neighborPaneId(stacked, 'pane-sw', 'right')).toBe('pane-se');
  });

  it('reports pane order, membership, and the enclosing split', () => {
    expect(panesInOrder(root).map((pane) => pane.id)).toEqual([
      'pane-left',
      'pane-top',
      'pane-bottom',
    ]);
    expect(containsPane(root, 'pane-bottom')).toBe(true);
    expect(containsPane(root, 'pane-missing')).toBe(false);
    expect(parentSplit(root, 'pane-top')).toMatchObject({ split: { id: 'split-right' }, branch: 0 });
    expect(parentSplit(root, 'pane-left')).toMatchObject({ split: { id: 'split-root' }, branch: 0 });
  });

  it('weights an even layout by how many panes each side holds', () => {
    expect(equalizeSplits(root)).toMatchObject({
      id: 'split-root',
      ratio: 1 / 3,
      children: [{ id: 'pane-left' }, { id: 'split-right', ratio: 0.5 }],
    });
  });
});

describe('workspace serialization', () => {
  it('does not persist a blank chooser as the active terminal', () => {
    const layout = serializeWorkspace(
      { id: 'pane', type: 'pane', activeTabId: 'blank-tab' },
      [
        {
          id: 'session-tab',
          paneId: 'pane',
          title: 'Production',
          profile: { kind: 'ssh', target: 'production' },
        },
      ],
      'pane',
    );

    expect(layout.root).toMatchObject({
      type: 'pane',
      activeTabId: 'session-tab',
      tabs: [{ id: 'session-tab' }],
    });
  });

  it('automatically reconnects local tabs while remote tabs wait', () => {
    const layout = serializeWorkspace(
      root,
      [
        {
          id: 'tab-a',
          paneId: 'pane-left',
          title: 'Production',
          profile: { kind: 'ssh', target: 'production' },
        },
        {
          id: 'tab-b',
          paneId: 'pane-bottom',
          title: 'Local',
          profile: { kind: 'local', cwd: '/srv/app' },
        },
      ],
      'pane-bottom',
    );

    expect(layout.root).toMatchObject({
      type: 'split',
      children: [
        {
          type: 'pane',
          tabs: [
            {
              kind: 'terminal',
              profile: { kind: 'ssh', target: 'production' },
              offerReconnect: true,
            },
          ],
        },
        {
          type: 'split',
          children: [
            { tabs: [] },
            { tabs: [{ cwdHint: '/srv/app', offerReconnect: true }] },
          ],
        },
      ],
    });

    const restored = restoreWorkspace(layout)!;
    expect(restored.activePaneId).toBe('pane-bottom');
    expect(restored.activeId).toBe('tab-b');
    expect(restored.tabs).toEqual([
      expect.objectContaining({ id: 'tab-a', paneId: 'pane-left', connectOnMount: false }),
      expect.objectContaining({ id: 'tab-b', paneId: 'pane-bottom', connectOnMount: true }),
    ]);
  });

  it('dials remote tabs too when the restore opts in', () => {
    const layout = serializeWorkspace(
      root,
      [
        {
          id: 'tab-a',
          paneId: 'pane-left',
          title: 'Production',
          profile: { kind: 'ssh', target: 'production' },
        },
        {
          id: 'tab-b',
          paneId: 'pane-bottom',
          title: 'Local',
          profile: { kind: 'local', cwd: '/srv/app' },
        },
      ],
      'pane-bottom',
    );

    const restored = restoreWorkspace(layout, { connectRemote: true })!;
    expect(restored.tabs).toEqual([
      expect.objectContaining({ id: 'tab-a', connectOnMount: true }),
      expect.objectContaining({ id: 'tab-b', connectOnMount: true }),
    ]);
  });

  it('strips retired TERM overrides from restored profiles', () => {
    const layout = serializeWorkspace(
      { id: 'pane', type: 'pane', activeTabId: 'ssh-tab' },
      [
        {
          id: 'ssh-tab',
          paneId: 'pane',
          title: 'Router',
          profile: { kind: 'ssh', target: 'router' },
        },
        {
          id: 'screen-tab',
          paneId: 'pane',
          title: 'Screen host',
          profile: { kind: 'ssh', target: 'screen-host' },
        },
      ],
      'pane',
    );
    const pane = layout.root?.type === 'pane' ? layout.root : undefined;
    if (pane?.tabs[0]?.kind === 'terminal') Object.assign(pane.tabs[0].profile, { term: 'xterm-kitty' });
    if (pane?.tabs[1]?.kind === 'terminal') Object.assign(pane.tabs[1].profile, { term: 'screen-256color' });

    const restored = restoreWorkspace(layout)!;
    expect(restored.tabs.map((tab) => tab.profile)).toEqual([
      { kind: 'ssh', target: 'router' },
      { kind: 'ssh', target: 'screen-host' },
    ]);
    expect(pane?.tabs[0]?.kind === 'terminal' && 'term' in pane.tabs[0].profile).toBe(true);
  });
});
