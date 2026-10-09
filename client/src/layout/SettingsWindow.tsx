import { useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import type { AppWindowLaunch } from '@muxus/shared';
import {
  ClientSessionImportDialog,
  SettingsBody,
  useSettingsNavigation,
  type SessionImportSource,
} from '../components/SettingsDialog.js';
import { isSettingsSection, type SettingsTarget } from '../state/ui.js';
import { layout } from '../theme.js';

type SettingsLaunch = Extract<AppWindowLaunch, { kind: 'settings' }>;

function settingsTarget(target: { section?: string; item?: string }): SettingsTarget | undefined {
  return isSettingsSection(target.section)
    ? { section: target.section, item: target.item }
    : undefined;
}

/**
 * Settings in a native window of their own, as the desktop app shows them:
 * the window can sit beside the app or on another display, and the desktop
 * shell reopens it where it was left. Preferences changed here reach every
 * app window as they are saved.
 */
export function SettingsWindow({ launch }: { launch: SettingsLaunch }) {
  const navigation = useSettingsNavigation(settingsTarget(launch));
  const { show, section, loggingDirty } = navigation;
  const [sessionImport, setSessionImport] = useState<SessionImportSource | null>(null);

  useEffect(() => {
    document.title = 'Settings — Muxus';
  }, []);

  // An app window asked for a section while this window was already open.
  useEffect(
    () =>
      window.muxusDesktop?.onSettingsTarget((target) => {
        const next = settingsTarget(target);
        if (next) show(next);
      }),
    [show],
  );

  // Esc closes the window as it closes the dialog. Menus, nested dialogs and
  // the shortcut recorder handle their own Esc first and keep it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      window.muxusDesktop?.closeWindow();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Unsaved logging edits hold the window open; the desktop shell then asks
  // whether to discard them, whichever way the window is being closed.
  useEffect(() => {
    if (!loggingDirty || section !== 'logging') return;
    const hold = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', hold);
    return () => window.removeEventListener('beforeunload', hold);
  }, [loggingDirty, section]);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static" color="transparent" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        {/* The window is frameless: this toolbar is its titlebar, a drag
            region that leaves room for the native window controls. */}
        <Toolbar
          variant="dense"
          sx={{
            WebkitAppRegion: 'drag',
            '&&': {
              minHeight: layout.topBarHeight,
              pl: 'calc(env(titlebar-area-x, 0px) + 20px)',
              pr: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 16px)',
            },
          }}
        >
          <Typography component="h1" sx={{ fontSize: 16, fontWeight: 650 }}>
            Settings
          </Typography>
        </Toolbar>
      </AppBar>
      <SettingsBody navigation={navigation} onImport={setSessionImport} />
      {sessionImport ? (
        <ClientSessionImportDialog source={sessionImport} onClose={() => setSessionImport(null)} />
      ) : null}
    </Box>
  );
}
