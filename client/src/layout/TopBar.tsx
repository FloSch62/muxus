import { memo, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import BrightnessAutoOutlinedIcon from '@mui/icons-material/BrightnessAutoOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { useForwards } from '../api/queries.js';
import { copyToClipboard } from '../clipboard.js';
import { layout } from '../theme.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { showToast } from '../state/toast.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { terminalHandle } from '../terminal/terminal-registry.js';

export const TopBar = memo(function TopBar() {
  const mode = usePrefsStore((s) => s.themeMode);
  const toggleTheme = usePrefsStore((s) => s.toggleTheme);
  const sidebarCollapsed = usePrefsStore((s) => s.sidebarCollapsed);
  const setPrefs = usePrefsStore((s) => s.set);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
  const forwardingOpen = useUiStore((s) => s.forwardingOpen);
  const setForwardingOpen = useUiStore((s) => s.setForwardingOpen);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const updateTab = useTabsStore((s) => s.update);
  const requestSearch = useTabsStore((s) => s.requestSearch);
  const { data: forwardsData } = useForwards();
  const activeForwards = forwardsData?.forwards.length ?? 0;
  const sshReady = !!activeTab?.connId;
  const [terminalMenu, setTerminalMenu] = useState<HTMLElement | null>(null);
  // Re-render hook so the zoom percentage in the open menu stays current.
  const [, setZoomTick] = useState(0);

  const handle = () => terminalHandle(activeTab?.id);
  const closeMenu = () => setTerminalMenu(null);

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
        {activeTab && (
          <Tooltip title={`Find in terminal (${HOTKEY_MOD_LABEL}Shift+F)`}>
            <IconButton size="small" aria-label="Find in terminal" onClick={requestSearch}>
              <SearchOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {sshReady && (
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
        )}
        <Tooltip title={`Port forwarding & tunnels${activeForwards ? ` — ${activeForwards} active` : ''}`}>
          <IconButton
            size="small"
            aria-label="Toggle forwarding panel"
            color={forwardingOpen ? 'primary' : 'default'}
            onClick={() => setForwardingOpen(!forwardingOpen)}
          >
            <Badge badgeContent={activeForwards} color="success" max={99} slotProps={{ badge: { sx: { fontSize: 9, height: 14, minWidth: 14 } } }}>
              <SwapHorizOutlinedIcon fontSize="small" />
            </Badge>
          </IconButton>
        </Tooltip>
        {activeTab && (
          <Tooltip title="Terminal actions">
            <IconButton size="small" aria-label="Terminal actions" onClick={(e) => setTerminalMenu(e.currentTarget)}>
              <MoreVertIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={mode === 'light' ? 'Switch to dark mode' : mode === 'dark' ? 'Follow system theme' : 'Switch to light mode'}>
          <IconButton size="small" aria-label="Toggle theme" onClick={toggleTheme}>
            {mode === 'light' ? <DarkModeOutlinedIcon fontSize="small" /> : mode === 'dark' ? <BrightnessAutoOutlinedIcon fontSize="small" /> : <LightModeOutlinedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Keyboard shortcuts">
          <IconButton size="small" aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
            <KeyboardOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Settings">
          <IconButton size="small" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            <SettingsOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Toolbar>

      <Menu open={!!terminalMenu} anchorEl={terminalMenu} onClose={closeMenu}>
        <MenuItem
          onClick={() => {
            closeMenu();
            requestSearch();
          }}
        >
          <ListItemIcon>
            <SearchOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Find</ListItemText>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>{`${HOTKEY_MOD_LABEL}Shift+F`}</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeMenu();
            handle()?.selectAll();
          }}
        >
          <ListItemIcon>
            <SelectAllIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Select all</ListItemText>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>{`${HOTKEY_MOD_LABEL}Shift+A`}</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeMenu();
            const text = handle()?.bufferText();
            if (text !== undefined) {
              void copyToClipboard(text).then((ok) => {
                if (ok) showToast('success', 'Terminal output copied.');
              });
            }
          }}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy all output</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            closeMenu();
            const text = handle()?.bufferText();
            if (text !== undefined && activeTab) saveTextFile(exportFilename(activeTab.title, 'txt'), text);
          }}
        >
          <ListItemIcon>
            <DescriptionOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Export as text</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeMenu();
            const html = handle()?.bufferHtml();
            if (html !== undefined && activeTab) saveTextFile(exportFilename(activeTab.title, 'html'), html, 'text/html');
          }}
        >
          <ListItemIcon>
            <CodeOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Export as HTML (colors)</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            closeMenu();
            handle()?.clear();
          }}
        >
          <ListItemIcon>
            <DeleteSweepOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Clear scrollback</ListItemText>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>{`${HOTKEY_MOD_LABEL}Shift+K`}</Typography>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            handle()?.zoomIn();
            setZoomTick((n) => n + 1);
          }}
        >
          <ListItemIcon>
            <ZoomInIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Zoom in</ListItemText>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>{`${HOTKEY_MOD_LABEL}Shift++`}</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            handle()?.zoomOut();
            setZoomTick((n) => n + 1);
          }}
        >
          <ListItemIcon>
            <ZoomOutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Zoom out</ListItemText>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>{`${HOTKEY_MOD_LABEL}Shift+-`}</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            handle()?.zoomReset();
            setZoomTick((n) => n + 1);
          }}
        >
          <ListItemIcon sx={{ fontSize: 12 }}>{`${handle()?.zoomPercent() ?? 100}%`}</ListItemIcon>
          <ListItemText>Reset zoom</ListItemText>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>{`${HOTKEY_MOD_LABEL}Shift+0`}</Typography>
        </MenuItem>
      </Menu>
    </AppBar>
  );
});
