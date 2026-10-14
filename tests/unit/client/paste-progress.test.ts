import { describe, expect, it } from 'vitest';
import {
  markPasteStopNoted,
  pasteStoppedNotice,
} from '../../../client/src/state/paste-progress.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { adoptTransferredTab } from '../../../client/src/tab-transfer.js';

describe('pasteStoppedNotice', () => {
  it('shows why a paste stopped, with the device output it quotes made safe to print', () => {
    expect(
      pasteStoppedNotice(
        "Line 2 of 3 (“switchport mode acess”) was answered with “% Invalid input detected at '^' marker.”",
      ),
    ).toBe(
      "\x1b[33m[paste stopped: Line 2 of 3 (“switchport mode acess”) was answered with “% Invalid input detected at '^' marker.”]\x1b[0m\r\n",
    );
    expect(pasteStoppedNotice('Line 1 of 2 (“one”): the error pattern took too long to match.')).toBe(
      '\x1b[33m[paste stopped: Line 1 of 2 (“one”): the error pattern took too long to match]\x1b[0m\r\n',
    );
    expect(pasteStoppedNotice('Line 1 of 1 was answered with “\x1b[2Jx\x07”')).toBe(
      '\x1b[33m[paste stopped: Line 1 of 1 was answered with “x”]\x1b[0m\r\n',
    );
  });
});

describe('markPasteStopNoted', () => {
  it('notes each stop of a session once, also in the window the tab moves to', () => {
    const tabId = useTabsStore.getState().open({ kind: 'ssh', target: 'router.example' }, 'router');

    expect(markPasteStopNoted(tabId, 1)).toBe(true);
    // A renderer that returns is sent the same stop again.
    expect(markPasteStopNoted(tabId, 1)).toBe(false);
    expect(markPasteStopNoted(tabId, 2)).toBe(true);

    // The tab another window adopts carries the stop it noted.
    const { paneId, ...moved } = useTabsStore.getState().tabs.find((tab) => tab.id === tabId)!;
    useTabsStore.setState({ tabs: [] });
    expect(adoptTransferredTab(moved, paneId)).toBe(true);
    expect(markPasteStopNoted(tabId, 2)).toBe(false);
    expect(markPasteStopNoted(tabId, 3)).toBe(true);

    // A new session numbers its stops afresh, and the tab forgets what it noted.
    useTabsStore.getState().update(tabId, { pasteStopNoted: undefined });
    expect(markPasteStopNoted(tabId, 1)).toBe(true);
  });
});
