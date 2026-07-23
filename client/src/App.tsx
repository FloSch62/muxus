import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { buildTheme } from './theme.js';
import { setTitleBarMode } from './titlebar-overlay.js';
import { usePrefsStore } from './state/prefs.js';
import { AppShell } from './layout/AppShell.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { HostEditorDialog } from './components/HostEditorDialog.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { ToastHost } from './components/ToastHost.js';
import { BackendStatusBanner } from './components/BackendStatusBanner.js';

export default function App() {
  const themeMode = usePrefsStore((s) => s.themeMode);
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
        <AppShell />
      </ErrorBoundary>
      <HostEditorDialog />
      <SettingsDialog />
      <ToastHost />
      <BackendStatusBanner />
    </ThemeProvider>
  );
}
