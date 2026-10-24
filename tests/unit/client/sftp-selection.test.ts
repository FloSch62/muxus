import { describe, expect, it } from 'vitest';
import type { SftpEntry } from '@muxus/shared';
import {
  EMPTY_SFTP_SELECTION,
  selectAllSftpEntries,
  selectedSftpEntries,
  selectSftpEntry,
  sftpContextSelection,
  sftpEntryCount,
  sftpSelectGesture,
  type SftpSelection,
} from '../../../client/src/sftp-selection.js';

const ORDER = ['logs', 'a.txt', 'b.txt', 'c.txt', 'd.txt'];

const names = (selection: SftpSelection) => [...selection.names].sort();

describe('sftpSelectGesture', () => {
  const click = (modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it('toggles with Ctrl on Windows and Linux and with Command on macOS', () => {
    expect(sftpSelectGesture(click({ ctrlKey: true }), false)).toBe('toggle');
    expect(sftpSelectGesture(click({ metaKey: true }), true)).toBe('toggle');
    // Ctrl-click is the secondary click on macOS, and Command is not a selection key elsewhere.
    expect(sftpSelectGesture(click({ ctrlKey: true }), true)).toBe('only');
    expect(sftpSelectGesture(click({ metaKey: true }), false)).toBe('only');
  });

  it('extends with Shift and selects one entry otherwise', () => {
    expect(sftpSelectGesture(click({ shiftKey: true }), false)).toBe('extend');
    expect(sftpSelectGesture(click({ shiftKey: true, ctrlKey: true }), false)).toBe('extend');
    expect(sftpSelectGesture(click(), true)).toBe('only');
  });
});

describe('selectSftpEntry', () => {
  it('selects only the clicked entry on a plain click', () => {
    const toggled = selectSftpEntry(EMPTY_SFTP_SELECTION, 'a.txt', 'toggle', ORDER);
    expect(names(selectSftpEntry(toggled, 'c.txt', 'only', ORDER))).toEqual(['c.txt']);
  });

  it('adds and removes entries with Ctrl/Cmd-click', () => {
    const one = selectSftpEntry(EMPTY_SFTP_SELECTION, 'a.txt', 'only', ORDER);
    const two = selectSftpEntry(one, 'c.txt', 'toggle', ORDER);
    expect(names(two)).toEqual(['a.txt', 'c.txt']);
    expect(names(selectSftpEntry(two, 'a.txt', 'toggle', ORDER))).toEqual(['c.txt']);
  });

  it('selects the run from the last click with Shift, in either direction', () => {
    const anchored = selectSftpEntry(EMPTY_SFTP_SELECTION, 'b.txt', 'only', ORDER);
    expect(names(selectSftpEntry(anchored, 'd.txt', 'extend', ORDER))).toEqual(['b.txt', 'c.txt', 'd.txt']);
    expect(names(selectSftpEntry(anchored, 'logs', 'extend', ORDER))).toEqual(['a.txt', 'b.txt', 'logs']);
  });

  it('shrinks the run again when the Shift-click moves back', () => {
    const anchored = selectSftpEntry(EMPTY_SFTP_SELECTION, 'a.txt', 'only', ORDER);
    const long = selectSftpEntry(anchored, 'd.txt', 'extend', ORDER);
    expect(names(selectSftpEntry(long, 'b.txt', 'extend', ORDER))).toEqual(['a.txt', 'b.txt']);
  });

  it('keeps what was Ctrl/Cmd-selected before the run', () => {
    const first = selectSftpEntry(EMPTY_SFTP_SELECTION, 'logs', 'only', ORDER);
    const anchored = selectSftpEntry(first, 'c.txt', 'toggle', ORDER);
    expect(names(selectSftpEntry(anchored, 'd.txt', 'extend', ORDER))).toEqual(['c.txt', 'd.txt', 'logs']);
  });

  it('treats Shift-click without an anchor, or on an anchor gone since, as a fresh start', () => {
    expect(names(selectSftpEntry(EMPTY_SFTP_SELECTION, 'c.txt', 'extend', ORDER))).toEqual(['c.txt']);
    const anchored = selectSftpEntry(EMPTY_SFTP_SELECTION, 'gone.txt', 'only', [...ORDER, 'gone.txt']);
    expect(names(selectSftpEntry(anchored, 'c.txt', 'extend', ORDER))).toEqual(['c.txt']);
  });
});

describe('sftpContextSelection', () => {
  it('keeps a selection the right-click lands in and replaces one it misses', () => {
    const selection = selectSftpEntry(
      selectSftpEntry(EMPTY_SFTP_SELECTION, 'a.txt', 'only', ORDER),
      'b.txt',
      'toggle',
      ORDER,
    );
    expect(sftpContextSelection(selection, 'b.txt')).toBe(selection);
    expect(names(sftpContextSelection(selection, 'd.txt'))).toEqual(['d.txt']);
  });
});

describe('selected entries', () => {
  const entry = (name: string, type: SftpEntry['type']): SftpEntry => ({ name, type });
  const entries = [entry('logs', 'dir'), entry('a.txt', 'file'), entry('b.txt', 'file')];

  it('selects everything with Ctrl/Cmd+A and lists entries in listing order', () => {
    const all = selectAllSftpEntries(entries.map((candidate) => candidate.name));
    expect(selectedSftpEntries(entries, all).map((candidate) => candidate.name)).toEqual(['logs', 'a.txt', 'b.txt']);
  });

  it('drops names that are no longer listed', () => {
    const selection = { names: new Set(['b.txt', 'deleted.txt']) };
    expect(selectedSftpEntries(entries, selection)).toEqual([entry('b.txt', 'file')]);
  });

  it('counts files and folders for confirmations', () => {
    expect(sftpEntryCount(entries)).toBe('2 files and 1 folder');
    expect(sftpEntryCount([entry('a.txt', 'file')])).toBe('1 file');
    expect(sftpEntryCount([entry('logs', 'dir'), entry('tmp', 'dir')])).toBe('2 folders');
  });
});
