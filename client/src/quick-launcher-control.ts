import { loadQuickLauncherDialog } from './lazy-features.js';
import { useUiStore } from './state/ui.js';

/** Open from either the document shortcut layer or xterm's key interceptor. */
export function openQuickLauncher(): void {
  void loadQuickLauncherDialog();
  useUiStore.getState().setQuickLauncherOpen(true);
}
