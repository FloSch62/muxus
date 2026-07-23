import { beforeEach, describe, expect, it } from 'vitest';
import { useTabsStore } from '../../../client/src/state/tabs.js';

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
  });
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
