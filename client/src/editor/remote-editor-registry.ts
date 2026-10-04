import { confirmAction } from '../state/dialogs.js';

interface RemoteEditorHandle {
  hasDirty(): boolean;
  /** Close the file in front; false when the terminal is in front instead. */
  closeActive(): boolean;
}

const handles = new Map<string, RemoteEditorHandle>();

export function registerRemoteEditor(tabId: string, handle: RemoteEditorHandle): () => void {
  handles.set(tabId, handle);
  return () => {
    if (handles.get(tabId) === handle) handles.delete(tabId);
  };
}

/** One deliberate confirmation covers every dirty file in the requested tab set. */
export async function confirmDiscardRemoteEditors(tabIds: string[]): Promise<boolean> {
  const dirty = tabIds.some((tabId) => handles.get(tabId)?.hasDirty());
  if (!dirty) return true;
  return confirmAction({
    title: 'Discard unsaved files?',
    description:
      'One or more files have unsaved changes. Closing them now loses those edits.',
    confirmLabel: 'Discard changes',
    destructive: true,
  });
}

/** Route the desktop close-file chord to the active Monaco tab before the
 * containing terminal or SFTP window is considered for closing. */
export function requestCloseRemoteEditor(tabId: string): boolean {
  return handles.get(tabId)?.closeActive() ?? false;
}
