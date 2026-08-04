import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import type { AppWindowLaunch } from '@muxus/shared';
import { setDebugLogging } from './api/logs.js';
import { applyInterfaceZoom } from './interface-zoom.js';
import { buildTheme } from './theme.js';
import { setTitleBarMode } from './titlebar-overlay.js';
import { usePrefsStore } from './state/prefs.js';
import { useUiStore } from './state/ui.js';
import { AppShell } from './layout/AppShell.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { BackendStatusBanner } from './components/BackendStatusBanner.js';
import { UpdateNotification } from './components/UpdateNotification.js';
import { useDialogStore } from './state/dialogs.js';
import { useToastStore } from './state/toast.js';
import {
  loadHostEditorDialog,
  loadFolderDialog,
  loadHostOrganizationDialog,
  loadCommandButtonMenu,
  loadCommandButtonsDialog,
  loadSettingsDialog,
  loadShortcutsDialog,
  loadSessionHistoryDialog,
  loadLogViewerDialog,
  loadQuickLauncherDialog,
  loadWorkspaceDialog,
} from './lazy-features.js';

const HostEditorDialog = lazy(() =>
  loadHostEditorDialog().then((module) => ({ default: module.HostEditorDialog })),
);
const HostOrganizationDialog = lazy(() =>
  loadHostOrganizationDialog().then((module) => ({ default: module.HostOrganizationDialog })),
);
const FolderDialog = lazy(() =>
  loadFolderDialog().then((module) => ({ default: module.FolderDialog })),
);
const SettingsDialog = lazy(() =>
  loadSettingsDialog().then((module) => ({ default: module.SettingsDialog })),
);
const PasswordVaultStartupUnlock = lazy(() =>
  import('./components/PasswordVaultStartupUnlock.js').then((module) => ({
    default: module.PasswordVaultStartupUnlock,
  })),
);
const DialogHost = lazy(() =>
  import('./components/DialogHost.js').then((module) => ({
    default: module.DialogHost,
  })),
);
const ToastHost = lazy(() =>
  import('./components/ToastHost.js').then((module) => ({
    default: module.ToastHost,
  })),
);
const CommandButtonMenu = lazy(() =>
  loadCommandButtonMenu().then((module) => ({ default: module.CommandButtonMenu })),
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
const LogViewerDialog = lazy(() =>
  loadLogViewerDialog().then((module) => ({ default: module.LogViewerDialog })),
);
const QuickLauncherDialog = lazy(() =>
  loadQuickLauncherDialog().then((module) => ({ default: module.QuickLauncherDialog })),
);
const WorkspaceDialog = lazy(() =>
  loadWorkspaceDialog().then((module) => ({ default: module.WorkspaceDialog })),
);
const SftpWindow = lazy(() =>
  import('./layout/SftpWindow.js').then((module) => ({ default: module.SftpWindow })),
);

export default function App({ launch }: { launch?: AppWindowLaunch }) {
  const themeMode = usePrefsStore((s) => s.themeMode);
  const interfaceZoom = usePrefsStore((s) => s.interfaceZoom);
  const debugMode = usePrefsStore((s) => s.debugMode);
  const hostEditorOpen = useUiStore((s) => !!s.hostEditor);
  const hostOrganizerOpen = useUiStore((s) => !!s.hostOrganizer);
  const folderDialogOpen = useUiStore((s) => !!s.folderDialog);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const commandButtonMenuOpen = useUiStore((s) => s.commandButtonMenuOpen);
  const commandButtonsOpen = useUiStore((s) => s.commandButtonsOpen);
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen);
  const historyOpen = useUiStore((s) => s.historyOpen);
  const logViewerOpen = useUiStore((s) => s.logViewerOpen);
  const quickLauncherOpen = useUiStore((s) => s.quickLauncherOpen);
  const workspacesOpen = useUiStore((s) => s.workspacesOpen);
  const dialogOpen = useDialogStore((s) => s.queue.length > 0);
  const toastOpen = useToastStore((s) => !!s.toast);
  const [startupReady, setStartupReady] = useState(false);
  const [osTheme, setOsTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  const finishStartup = useCallback(() => setStartupReady(true), []);
  const effectiveMode = themeMode === 'os' ? osTheme : themeMode;
  const theme = useMemo(() => buildTheme(effectiveMode), [effectiveMode]);
  useLayoutEffect(() => {
    // Keep the desktop app's native window controls in sync with the theme.
    setTitleBarMode(effectiveMode);
  }, [effectiveMode]);
  useLayoutEffect(() => {
    applyInterfaceZoom(interfaceZoom);
  }, [interfaceZoom]);
  useEffect(() => {
    // The debug pref lives client-side; tell the server its log level on boot
    // and on every toggle. Failures are ignored — the pref re-syncs next time.
    void setDebugLogging(debugMode).catch(() => undefined);
  }, [debugMode]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setOsTheme(e.matches ? 'dark' : 'light');
    setOsTheme(mq.matches ? 'dark' : 'light');
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
          <AppShell persistWorkspace={!launch && startupReady} />
        )}
      </ErrorBoundary>
      <Suspense fallback={null}>
        {hostEditorOpen ? <HostEditorDialog /> : null}
        {hostOrganizerOpen ? <HostOrganizationDialog /> : null}
        {folderDialogOpen ? <FolderDialog /> : null}
        {settingsOpen ? <SettingsDialog /> : null}
        {commandButtonMenuOpen ? <CommandButtonMenu /> : null}
        {commandButtonsOpen ? <CommandButtonsDialog /> : null}
        {shortcutsOpen ? <ShortcutsDialog /> : null}
        {historyOpen ? <SessionHistoryDialog /> : null}
        {logViewerOpen ? <LogViewerDialog /> : null}
        {quickLauncherOpen ? <QuickLauncherDialog /> : null}
        {workspacesOpen ? <WorkspaceDialog /> : null}
        {!launch ? <PasswordVaultStartupUnlock onReady={finishStartup} /> : null}
        {dialogOpen ? <DialogHost /> : null}
        {toastOpen ? <ToastHost /> : null}
      </Suspense>
      <BackendStatusBanner />
      {!launch ? <UpdateNotification /> : null}
    </ThemeProvider>
  );
}
