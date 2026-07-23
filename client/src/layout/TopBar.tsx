import { memo } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import BrightnessAutoOutlinedIcon from '@mui/icons-material/BrightnessAutoOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import { layout } from '../theme.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';

export const TopBar = memo(function TopBar() {
  const mode = usePrefsStore((s) => s.themeMode);
  const toggleTheme = usePrefsStore((s) => s.toggleTheme);
  const sidebarCollapsed = usePrefsStore((s) => s.sidebarCollapsed);
  const setPrefs = usePrefsStore((s) => s.set);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setForwardsOpen = useUiStore((s) => s.setForwardsOpen);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const updateTab = useTabsStore((s) => s.update);
  const sshReady = !!activeTab?.connId;

  return (
    <AppBar position="static" color="transparent" sx={{ borderBottom: 1, borderColor: 'divider' }}>
      {/* In the desktop app the window is frameless and this toolbar doubles as
          the titlebar: it is a drag region, and the env(titlebar-area-*) vars
          reserve space for the native window controls (traffic lights on the
          left on macOS, min/max/close on the right on Windows/Linux). In a
          regular browser the env() fallbacks make all of this a no-op. */}
      <Toolbar
        variant="dense"
        sx={{
          gap: 1.5,
          minHeight: layout.topBarHeight,
          WebkitAppRegion: 'drag',
          // double the specificity: MUI's responsive gutter rule wins otherwise
          '&&': {
            pl: 'calc(env(titlebar-area-x, 0px) + 16px)',
            pr: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 16px)',
          },
          '& button, & input, & a, & [role="button"]': {
            WebkitAppRegion: 'no-drag',
          },
        }}
      >
        <Tooltip title={`Toggle sessions (${HOTKEY_MOD_LABEL}B)`}>
          <IconButton size="small" aria-label="Toggle sessions" onClick={() => setPrefs({ sidebarCollapsed: !sidebarCollapsed })} sx={{ mr: 0.5 }}>
            <MenuIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Stack direction="row" spacing={1} sx={{ mr: 1.5, alignItems: 'center' }}>
          <Box component="img" src="/muxus.svg" alt="" aria-hidden sx={{ width: 28, height: 28, display: 'block' }} />
          <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: 0 }}>
            Muxus
          </Typography>
        </Stack>
        <Box sx={{ flex: 1 }} />
        {sshReady && (
          <>
            <Tooltip title={activeTab.sftpOpen ? 'Hide file browser' : 'Browse files (SFTP)'}>
              <IconButton
                size="small"
                aria-label="Toggle file browser"
                color={activeTab.sftpOpen ? 'primary' : 'default'}
                onClick={() => updateTab(activeTab.id, { sftpOpen: !activeTab.sftpOpen })}
              >
                <FolderOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Port forwarding">
              <IconButton size="small" aria-label="Port forwarding" onClick={() => setForwardsOpen(true)}>
                <SwapHorizOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
        <Tooltip title={mode === 'light' ? 'Switch to dark mode' : mode === 'dark' ? 'Follow system theme' : 'Switch to light mode'}>
          <IconButton size="small" aria-label="Toggle theme" onClick={toggleTheme}>
            {mode === 'light' ? <DarkModeOutlinedIcon fontSize="small" /> : mode === 'dark' ? <BrightnessAutoOutlinedIcon fontSize="small" /> : <LightModeOutlinedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Settings">
          <IconButton size="small" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            <SettingsOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
});
