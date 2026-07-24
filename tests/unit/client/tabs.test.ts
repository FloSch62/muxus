import { beforeEach, describe, expect, it } from 'vitest';
import { requestClosePane } from '../../../client/src/session-actions.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { useUiStore } from '../../../client/src/state/ui.js';

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
  });
  usePrefsStore.setState({ confirmCloseConnected: true });
  useUiStore.setState({ confirmClose: null });
});

describe('blank session tabs', () => {
  it('opens an idle chooser instead of starting a local process', () => {
    const id = useTabsStore.getState().openEmpty();
    const state = useTabsStore.getState();

    expect(state.activeId).toBe(id);
    expect(state.tabs).toEqual([
      expect.objectContaining({
        id,
        title: 'New tab',
        profile: null,
        status: 'idle',
        connectOnMount: false,
      }),
    ]);
  });

  it('replaces the chooser when a local session is selected', () => {
    const state = useTabsStore.getState();
    const id = state.openEmpty();

    expect(state.replaceEmpty(id, { kind: 'local' }, 'Local')).toBe(true);
    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id,
        title: 'Local',
        profile: expect.objectContaining({ kind: 'local' }),
        status: 'connecting',
        connectOnMount: true,
      }),
    ]);
  });

  it('replaces the chooser when an SSH target is selected', () => {
    const state = useTabsStore.getState();
    const id = state.openEmpty();

    expect(
      state.replaceEmpty(id, { kind: 'ssh', target: 'edge-router' }, 'Edge router'),
    ).toBe(true);
    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id,
        title: 'Edge router',
        profile: expect.objectContaining({ kind: 'ssh', target: 'edge-router' }),
        status: 'connecting',
      }),
    ]);
  });
});

describe('workspace restoration', () => {
  it('starts restored local shells without reconnecting remote sessions', () => {
    useTabsStore.getState().restore({
      version: 1,
      root: {
        id: 'pane-restored',
        type: 'pane',
        activeTabId: 'local-tab',
        tabs: [
          {
            id: 'local-tab',
            kind: 'terminal',
            title: 'Local',
            profile: { kind: 'local', cwd: '/srv/app' },
            offerReconnect: true,
          },
          {
            id: 'ssh-tab',
            kind: 'terminal',
            title: 'Router',
            profile: { kind: 'ssh', target: 'router' },
            offerReconnect: true,
          },
        ],
      },
      activePaneId: 'pane-restored',
    });

    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: 'local-tab',
        status: 'connecting',
        connectOnMount: true,
      }),
      expect.objectContaining({
        id: 'ssh-tab',
        status: 'closed',
        connectOnMount: false,
      }),
    ]);
  });
});

describe('remote editor tabs', () => {
  it('opens, activates, and closes remote files without disturbing the terminal tab', () => {
    const store = useTabsStore.getState();
    const id = store.open({ kind: 'ssh', target: 'edge-router' }, 'Edge router');

    store.openEditor(id, '/etc/hosts');
    store.openEditor(id, '/etc/ssh/sshd_config');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      editorPaths: ['/etc/hosts', '/etc/ssh/sshd_config'],
      activeEditorPath: '/etc/ssh/sshd_config',
    });

    store.activateEditor(id, '/etc/hosts');
    store.closeEditor(id, '/etc/hosts');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      profile: { kind: 'ssh', target: 'edge-router' },
      editorPaths: ['/etc/ssh/sshd_config'],
      activeEditorPath: '/etc/ssh/sshd_config',
    });

    store.closeEditor(id, '/etc/ssh/sshd_config');
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      editorPaths: [],
      activeEditorPath: undefined,
    });
  });
});

describe('pane closing', () => {
  it('closes a non-empty pane and its tabs', () => {
    const store = useTabsStore.getState();
    const survivingTabId = store.open({ kind: 'local' }, 'Local');
    store.split('pane-test', 'horizontal');
    const closingPaneId = useTabsStore.getState().activePaneId;
    const closingTabId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');

    useTabsStore.getState().closePane(closingPaneId);

    const state = useTabsStore.getState();
    expect(state.root).toMatchObject({ id: 'pane-test', type: 'pane' });
    expect(state.tabs.map((tab) => tab.id)).toEqual([survivingTabId]);
    expect(state.tabs.some((tab) => tab.id === closingTabId)).toBe(false);
    expect(state.activePaneId).toBe('pane-test');
    expect(state.activeId).toBe(survivingTabId);
  });

  it('gates a pane containing live tabs behind the close confirmation', () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Local');
    store.split('pane-test', 'horizontal');
    const closingPaneId = useTabsStore.getState().activePaneId;
    const closingTabId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');
    useTabsStore.getState().update(closingTabId, { status: 'connected' });

    requestClosePane(closingPaneId);

    expect(useUiStore.getState().confirmClose).toEqual({
      tabIds: [closingTabId],
      paneId: closingPaneId,
    });
    expect(useTabsStore.getState().root.type).toBe('split');
  });

  it('closes a live pane immediately when confirmation is disabled', () => {
    const store = useTabsStore.getState();
    store.open({ kind: 'local' }, 'Local');
    store.split('pane-test', 'horizontal');
    const closingPaneId = useTabsStore.getState().activePaneId;
    const closingTabId = useTabsStore.getState().open({ kind: 'ssh', target: 'router' }, 'Router');
    useTabsStore.getState().update(closingTabId, { status: 'connected' });
    usePrefsStore.setState({ confirmCloseConnected: false });

    requestClosePane(closingPaneId);

    expect(useUiStore.getState().confirmClose).toBeNull();
    expect(useTabsStore.getState().root).toMatchObject({ id: 'pane-test', type: 'pane' });
  });
});
