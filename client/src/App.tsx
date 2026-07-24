import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import type { AppWindowLaunch } from '@muxus/shared';
import { buildTheme } from './theme.js';
import { setTitleBarMode } from './titlebar-overlay.js';
import { usePrefsStore } from './state/prefs.js';
import { useUiStore } from './state/ui.js';
import { AppShell } from './layout/AppShell.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ToastHost } from './components/ToastHost.js';
import { BackendStatusBanner } from './components/BackendStatusBanner.js';
import {
  loadHostEditorDialog,
  loadHostOrganizationDialog,
  loadCommandButtonsDialog,
  loadSettingsDialog,
  loadShortcutsDialog,
  loadSessionHistoryDialog,
  loadWorkspaceDialog,
} from './lazy-features.js';

const HostEditorDialog = lazy(() =>
  loadHostEditorDialog().then((module) => ({ default: module.HostEditorDialog })),
);
const HostOrganizationDialog = lazy(() =>
  loadHostOrganizationDialog().then((module) => ({ default: module.HostOrganizationDialog })),
);
const SettingsDialog = lazy(() =>
  loadSettingsDialog().then((module) => ({ default: module.SettingsDialog })),
);
const CommandButtonsDialog = lazy(() =>
  loadCommandButtonsDialog().then((module) => ({ default: module.CommandButtonsDialog })),
);
const ShortcutsDialog = lazy(() =>
  loadShortcutsDialog().then((module) => ({ default: module.ShortcutsDialog })),
);
const SessionHistoryDialog = lazy(() =>
  loadSessionHistoryDialog().then((module) => ({ default: module.SessionHistoryDialog })),
);
const WorkspaceDialog = lazy(() =>
  loadWorkspaceDialog().then((module) => ({ default: module.WorkspaceDialog })),
);
const SftpWindow = lazy(() =>
  import('./layout/SftpWindow.js').then((module) => ({ default: module.SftpWindow })),
);

export default function App({ launch }: { launch?: AppWindowLaunch }) {
  const themeMode = usePrefsStore((s) => s.themeMode);
  const hostEditorOpen = useUiStore((s) => !!s.hostEditor);
  const hostOrganizerOpen = useUiStore((s) => !!s.hostOrganizer);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const commandButtonsOpen = useUiStore((s) => s.commandButtonsOpen);
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen);
  const historyOpen = useUiStore((s) => s.historyOpen);
  const workspacesOpen = useUiStore((s) => s.workspacesOpen);
  const [osTheme, setOsTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  const effectiveMode = themeMode === 'os' ? osTheme : themeMode;
  const theme = useMemo(() => buildTheme(effectiveMode), [effectiveMode]);
  useLayoutEffect(() => {
    // Keep the desktop app's native window controls in sync with the theme.
    setTitleBarMode(effectiveMode);
  }, [effectiveMode]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setOsTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ErrorBoundary label="Muxus">
        {launch?.kind === 'sftp' ? (
          <Suspense fallback={null}>
            <SftpWindow launch={launch} />
          </Suspense>
        ) : (
          <AppShell persistWorkspace={!launch} />
        )}
      </ErrorBoundary>
      <Suspense fallback={null}>
        {hostEditorOpen ? <HostEditorDialog /> : null}
        {hostOrganizerOpen ? <HostOrganizationDialog /> : null}
        {settingsOpen ? <SettingsDialog /> : null}
        {commandButtonsOpen ? <CommandButtonsDialog /> : null}
        {shortcutsOpen ? <ShortcutsDialog /> : null}
        {historyOpen ? <SessionHistoryDialog /> : null}
        {workspacesOpen ? <WorkspaceDialog /> : null}
      </Suspense>
      <ToastHost />
      <BackendStatusBanner />
    </ThemeProvider>
  );
}
