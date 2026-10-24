import type { SftpEntry } from '@muxus/shared';

/**
 * Multi-selection in the file browser, kept free of React so it can be
 * tested. It works like a file manager: a click selects one entry, Ctrl-click
 * (Command-click on macOS) adds or removes one, and Shift-click selects the
 * run from the entry clicked last. As in the host tree, the run is re-derived
 * from what was selected around that anchor, so moving the Shift-click back
 * shrinks it again.
 */
export interface SftpSelection {
  names: ReadonlySet<string>;
  anchor?: { name: string; base: ReadonlySet<string> };
}

export const EMPTY_SFTP_SELECTION: SftpSelection = { names: new Set() };

export type SftpSelectGesture = 'only' | 'toggle' | 'extend';

/** What a click with these modifiers does to the selection. */
export function sftpSelectGesture(
  event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  isMac: boolean,
): SftpSelectGesture {
  if (event.shiftKey) return 'extend';
  // Ctrl-click is the secondary click on macOS.
  if (isMac ? event.metaKey : event.ctrlKey) return 'toggle';
  return 'only';
}

/** Apply a click on `name`; `order` is the listing as shown. */
export function selectSftpEntry(
  selection: SftpSelection,
  name: string,
  gesture: SftpSelectGesture,
  order: readonly string[],
): SftpSelection {
  if (gesture === 'toggle') {
    const names = new Set(selection.names);
    if (names.has(name)) names.delete(name);
    else names.add(name);
    return { names, anchor: { name, base: names } };
  }
  const { anchor } = selection;
  if (gesture === 'extend' && anchor) {
    const to = order.indexOf(name);
    const anchorIndex = order.indexOf(anchor.name);
    // An anchor no longer listed, such as a file deleted since, starts the run at the click.
    const from = anchorIndex >= 0 ? anchorIndex : to;
    const names = new Set(anchor.base);
    if (to >= 0) {
      for (const entry of order.slice(Math.min(from, to), Math.max(from, to) + 1)) names.add(entry);
    }
    return { names, anchor };
  }
  return { names: new Set([name]), anchor: { name, base: new Set() } };
}

/** A right-click keeps a selection it lands in, and otherwise selects just that entry. */
export function sftpContextSelection(selection: SftpSelection, name: string): SftpSelection {
  return selection.names.has(name)
    ? selection
    : { names: new Set([name]), anchor: { name, base: new Set() } };
}

/** Every listed entry, for Ctrl/Cmd+A. */
export function selectAllSftpEntries(order: readonly string[]): SftpSelection {
  return { names: new Set(order) };
}

/** The selected entries in listing order; names gone since the last refresh drop out. */
export function selectedSftpEntries(
  entries: readonly SftpEntry[],
  selection: SftpSelection,
): SftpEntry[] {
  return entries.filter((entry) => selection.names.has(entry.name));
}

/** "3 files and 1 folder" — what a bulk action is about to touch. */
export function sftpEntryCount(entries: readonly SftpEntry[]): string {
  const folders = entries.filter((entry) => entry.type === 'dir').length;
  const others = entries.length - folders;
  const parts = [
    others ? `${others} ${others === 1 ? 'file' : 'files'}` : '',
    folders ? `${folders} ${folders === 1 ? 'folder' : 'folders'}` : '',
  ].filter(Boolean);
  return parts.join(' and ');
}
