import { beforeEach, describe, expect, it } from 'vitest';
import type { SavedHostProfile, SshHostEntry } from '@muxus/shared';
import { hostSessionTabs, tabHostKey } from '../../../client/src/host-sessions.js';
import { managedHostKey } from '../../../client/src/managed-hosts.js';
import { useTabsStore, type TerminalTab } from '../../../client/src/state/tabs.js';

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    unreadOutputIds: new Set(),
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
    zoomedPaneId: null,
  });
});

const tab = (profile: Record<string, unknown> | null) =>
  ({ id: 't', status: 'connected', profile, title: 't' }) as unknown as TerminalTab;

describe('tabHostKey', () => {
  it('keys tabs the way the sidebar keys the hosts they came from', () => {
    const sshHost = { kind: 'ssh', entry: { alias: 'web' } as SshHostEntry } as const;
    const saved = { kind: 'profile', entry: { id: 'p1' } as SavedHostProfile } as const;

    expect(tabHostKey(tab({ kind: 'ssh', target: 'web' }))).toBe(managedHostKey(sshHost));
    expect(tabHostKey(tab({ kind: 'ssh', target: 'db', profileId: 'p1' }))).toBe(
      managedHostKey(saved),
    );
    expect(tabHostKey(tab({ kind: 'serial', path: '/dev/ttyUSB0', profileId: 'p1' }))).toBe(
      'profile:p1',
    );
  });

  it('leaves local shells, blank tabs and unsaved non-SSH sessions without a host', () => {
    expect(tabHostKey(tab({ kind: 'local' }))).toBeUndefined();
    expect(tabHostKey(tab(null))).toBeUndefined();
    expect(tabHostKey(tab({ kind: 'telnet', host: 'sw1' }))).toBeUndefined();
  });
});

describe('hostSessionTabs', () => {
  it('lists every tab of one host in window order, ended ones included', () => {
    const store = useTabsStore.getState();
    const first = store.open({ kind: 'ssh', target: 'web' }, 'web');
    store.open({ kind: 'ssh', target: 'db' }, 'db');
    store.open({ kind: 'local' }, 'Local');
    const rightPane = useTabsStore.getState().split('pane-test', 'right');
    expect(rightPane).toBeDefined();
    const second = useTabsStore.getState().open({ kind: 'ssh', target: 'web' }, 'web (2)');
    useTabsStore.getState().update(first, { status: 'closed' });

    const { root, tabs } = useTabsStore.getState();
    expect(hostSessionTabs(root, tabs, 'ssh:web').map((entry) => entry.id)).toEqual([
      first,
      second,
    ]);
    expect(hostSessionTabs(root, tabs, 'ssh:nowhere')).toEqual([]);
  });
});
