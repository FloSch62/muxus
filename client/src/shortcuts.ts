import { openEmptyTab, requestCloseTabs } from './session-actions.js';
import { requestCloseRemoteEditor } from './editor/remote-editor-registry.js';
import { usePrefsStore } from './state/prefs.js';
import { useTabsStore } from './state/tabs.js';

/**
 * App-level shortcuts, wired once at boot. The terminal's own key handler
 * mirrors the tab chords so they also work while a terminal has focus.
 * Desktop chords (Cmd/Ctrl+W, Ctrl+Tab) arrive over the Electron bridge —
 * the main process intercepts them before the page sees the keydown.
 */
export function installShortcuts(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && !e.altKey && e.code === 'KeyT') {
      e.preventDefault();
      openEmptyTab();
      return;
    }
    if (mod && e.shiftKey && !e.altKey && e.code === 'KeyF') {
      e.preventDefault();
      useTabsStore.getState().requestSearch();
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === 'PageUp' || e.code === 'PageDown')) {
      e.preventDefault();
      useTabsStore.getState().cycle(e.code === 'PageUp');
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyB') {
      e.preventDefault();
      const prefs = usePrefsStore.getState();
      prefs.set({ sidebarCollapsed: !prefs.sidebarCollapsed });
    }
  };
  window.addEventListener('keydown', onKeyDown);

  const unsubscribers = [
    window.muxusDesktop?.onCloseTab(() => {
      const { activeId, activePaneId, root, closePane } = useTabsStore.getState();
      if (activeId && requestCloseRemoteEditor(activeId)) return;
      if (activeId) requestCloseTabs([activeId]);
      else if (root.type === 'split') closePane(activePaneId);
      else window.muxusDesktop?.closeWindow();
    }),
    window.muxusDesktop?.onCycleTab((backwards) => {
      useTabsStore.getState().cycle(backwards);
    }),
  ];

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    for (const unsub of unsubscribers) unsub?.();
  };
}
