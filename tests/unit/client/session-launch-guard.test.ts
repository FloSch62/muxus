import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedHostProfile } from '@muxus/shared';
import {
  connectSavedHost,
  connectTarget,
  openLocalTerminal,
} from '../../../client/src/session-actions.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';

const savedHost: SavedHostProfile = {
  id: 'core-router',
  kind: 'telnet',
  name: 'Core router',
  profile: {
    kind: 'telnet',
    profileId: 'core-router',
    host: 'router.example.test',
    port: 2323,
  },
  metadata: { profileId: 'core-router', connectCount: 0 },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/** Move past the repeat window so the next launch is treated as deliberate. */
const settleGuard = () => vi.advanceTimersByTime(1000);

// The guard lives at module scope, so the clock has to march forward across
// the whole file — reinstalling it per test would rewind it under the guard.
beforeAll(() => {
  vi.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z') });
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  useTabsStore.setState({
    tabs: [],
    root: { id: 'pane-test', type: 'pane', activeTabId: null },
    activePaneId: 'pane-test',
    activeId: null,
    zoomedPaneId: null,
  });
  usePrefsStore.setState({ localShell: 'auto' });
  // Start each test outside the window left behind by the previous one.
  settleGuard();
});

describe('repeat launch guard', () => {
  it('opens one session when a host row is double-clicked', () => {
    const first = connectTarget('edge-router');
    const second = connectTarget('edge-router');

    expect(second).toBe(first);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it('keeps swallowing repeats while the row is being mashed', () => {
    const first = connectTarget('edge-router');
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(400);
      expect(connectTarget('edge-router')).toBe(first);
    }

    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it('opens a second session once the repeat window has passed', () => {
    const first = connectTarget('edge-router');
    settleGuard();
    const second = connectTarget('edge-router');

    expect(second).not.toBe(first);
    expect(useTabsStore.getState().tabs).toHaveLength(2);
  });

  it('does not swallow a different host clicked right after', () => {
    connectTarget('edge-router');
    connectTarget('core-switch');

    expect(useTabsStore.getState().tabs.map((tab) => tab.title)).toEqual([
      'edge-router',
      'core-switch',
    ]);
  });

  it('guards saved hosts by profile, not by title', () => {
    const first = connectSavedHost(savedHost);
    const second = connectSavedHost({ ...savedHost, name: 'Core router (renamed)' });

    expect(second).toBe(first);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it('guards the local terminal button', () => {
    const first = openLocalTerminal();
    const second = openLocalTerminal();

    expect(second).toBe(first);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it('reopens a host whose fresh tab was closed inside the window', () => {
    const first = connectTarget('edge-router');
    useTabsStore.getState().close(first);

    const second = connectTarget('edge-router');

    expect(second).not.toBe(first);
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([second]);
  });

  it('fills a blank tab once instead of leaving a stray session behind', () => {
    const blank = useTabsStore.getState().openEmpty();

    const first = connectTarget('edge-router', 'edge-router', blank);
    const second = connectTarget('edge-router', 'edge-router', blank);

    expect(first).toBe(blank);
    expect(second).toBe(blank);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });
});
