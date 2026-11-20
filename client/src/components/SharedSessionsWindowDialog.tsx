import { useQueryClient } from '@tanstack/react-query';
import { refreshSharedSessionsNow, useSharedSessionSources } from '../api/shared-sessions.js';
import { useUiStore } from '../state/ui.js';
import { ShareFolderDialog } from './ShareFolderDialog.js';
import { SharedSessionsDialog } from './SharedSessionsDialog.js';

/**
 * The shared sessions dialog a window opens from its sidebar or quick
 * launcher. Settings has its own copy next to the list of links.
 */
export function SharedSessionsWindowDialog() {
  const queryClient = useQueryClient();
  const state = useUiStore((s) => s.sharedSessionsDialog);
  const close = () => useUiStore.getState().setSharedSessionsDialog(false);
  const { data } = useSharedSessionSources();

  if (!state) return null;
  if (state.mode === 'share') return <ShareFolderDialog key={state.path} path={state.path} onClose={close} />;
  const source = state.sourceId
    ? data?.sources.find((candidate) => candidate.id === state.sourceId)
    : undefined;
  // Editing waits for the link it edits; a link removed meanwhile has nothing to edit.
  if (state.sourceId && !source) return null;
  return (
    <SharedSessionsDialog
      key={source?.id ?? 'new'}
      source={source}
      onClose={close}
      onSaved={(saved) => {
        close();
        void refreshSharedSessionsNow(queryClient, saved);
      }}
    />
  );
}
