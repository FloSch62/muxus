interface RemoteEditorHandle {
  hasDirty(): boolean;
}

const handles = new Map<string, RemoteEditorHandle>();

export function registerRemoteEditor(tabId: string, handle: RemoteEditorHandle): () => void {
  handles.set(tabId, handle);
  return () => {
    if (handles.get(tabId) === handle) handles.delete(tabId);
  };
}

/** One deliberate confirmation covers every dirty file in the requested tab set. */
export function confirmDiscardRemoteEditors(tabIds: string[]): boolean {
  const dirty = tabIds.some((tabId) => handles.get(tabId)?.hasDirty());
  return !dirty || window.confirm('One or more remote files have unsaved changes. Close and discard them?');
}
