import { memo, type ReactNode, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import KeyboardAltOutlinedIcon from '@mui/icons-material/KeyboardAltOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import WorkspacesOutlinedIcon from '@mui/icons-material/WorkspacesOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutlineOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutlineOutlined';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { useForwards } from '../api/queries.js';
import { copyToClipboard } from '../clipboard.js';
import { layout } from '../theme.js';
import { useChordLabel } from '../keymap/hints.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { showToast } from '../state/toast.js';
import { usePrefsStore, type ThemeMode } from '../state/prefs.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { useWorkspacesStore } from '../state/workspaces.js';
import { terminalHandle } from '../terminal/terminal-registry.js';
import { ChordHint, withChord } from '../components/ChordHint.js';
import { MultiExecControl } from '../components/MultiExecControl.js';
import {
  loadCommandButtonsDialog,
  loadForwardingPanel,
  loadSettingsDialog,
  loadSessionHistoryDialog,
  loadShortcutsDialog,
  loadWorkspaceDialog,
  loadSftpPanel,
} from '../lazy-features.js';

const APPEARANCE_OPTIONS = [
  { mode: 'light', label: 'Light', icon: <LightModeOutlinedIcon fontSize="small" /> },
  { mode: 'os', label: 'System', icon: <BrightnessAutoOutlinedIcon fontSize="small" /> },
  { mode: 'dark', label: 'Dark', icon: <DarkModeOutlinedIcon fontSize="small" /> },
] as const satisfies readonly { mode: ThemeMode; label: string; icon: ReactNode }[];
const SYSTEM_APPEARANCE = APPEARANCE_OPTIONS[1];

export const TopBar = memo(function TopBar() {
  const mode = usePrefsStore((s) => s.themeMode);
  const sidebarCollapsed = usePrefsStore((s) => s.sidebarCollapsed);
  const setPrefs = usePrefsStore((s) => s.set);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setCommandButtonsOpen = useUiStore((s) => s.setCommandButtonsOpen);
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
  const setHistoryOpen = useUiStore((s) => s.setHistoryOpen);
  const setWorkspacesOpen = useUiStore((s) => s.setWorkspacesOpen);
  const workspaceName = useWorkspacesStore((s) => s.activeName);
  const workspacesReady = useWorkspacesStore((s) => s.ready);
  const forwardingOpen = useUiStore((s) => s.forwardingOpen);
  const setForwardingOpen = useUiStore((s) => s.setForwardingOpen);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const updateTab = useTabsStore((s) => s.update);
  const requestSearch = useTabsStore((s) => s.requestSearch);
  const { data: forwardsData } = useForwards();
  const activeForwards = forwardsData?.forwards.length ?? 0;
  const sshReady = !!activeTab?.connId && activeTab.sftpAvailable !== false;
  const terminalReady = !!activeTab?.profile;
  const [terminalMenu, setTerminalMenu] = useState<HTMLElement | null>(null);
  const [appearanceMenu, setAppearanceMenu] = useState<HTMLElement | null>(null);
  const sidebarChord = useChordLabel('app.sidebar');
  const findChord = useChordLabel('terminal.find');
  const selectAllChord = useChordLabel('terminal.select-all');
  const clearChord = useChordLabel('terminal.clear');
  const zoomInChord = useChordLabel('terminal.zoom-in');
  const zoomOutChord = useChordLabel('terminal.zoom-out');
  const zoomResetChord = useChordLabel('terminal.zoom-reset');
  // Re-render hook so the zoom percentage in the open menu stays current.
  const [, setZoomTick] = useState(0);

  const handle = () => terminalHandle(activeTab?.id);
  const closeMenu = () => setTerminalMenu(null);
  const currentAppearance =
    APPEARANCE_OPTIONS.find((option) => option.mode === mode) ?? SYSTEM_APPEARANCE;

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
        <Tooltip title={withChord(sidebarCollapsed ? 'Show hosts' : 'Hide hosts', sidebarChord)}>
          <IconButton size="small" aria-label="Toggle hosts sidebar" onClick={() => setPrefs({ sidebarCollapsed: !sidebarCollapsed })} sx={{ mr: 0.5 }}>
            <MenuIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Stack direction="row" spacing={1} sx={{ mr: 1.5, alignItems: 'center' }}>
          <Box component="img" src="/muxus.svg" alt="" aria-hidden sx={{ width: 28, height: 28, display: 'block' }} />
          <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: 0 }}>
            Muxus
          </Typography>
        </Stack>
        <Button
          size="small"
          color="inherit"
          startIcon={<WorkspacesOutlinedIcon fontSize="small" />}
          disabled={!workspacesReady}
          onMouseEnter={() => void loadWorkspaceDialog()}
          onFocus={() => void loadWorkspaceDialog()}
          onClick={() => setWorkspacesOpen(true)}
          sx={{ maxWidth: 240, textTransform: 'none', justifyContent: 'flex-start' }}
        >
          <Typography variant="body2" noWrap>
            {workspaceName}
          </Typography>
        </Button>
        <Box sx={{ flex: 1 }} />
        <MultiExecControl />
        <Tooltip title="Saved command buttons">
          <IconButton
            size="small"
            aria-label="Manage saved command buttons"
            onMouseEnter={() => void loadCommandButtonsDialog()}
            onFocus={() => void loadCommandButtonsDialog()}
            onClick={() => setCommandButtonsOpen(true)}
          >
            <BoltOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {sshReady && (
          <Tooltip title={activeTab.sftpOpen ? 'Hide file browser' : 'Show file browser (SFTP)'}>
            <IconButton
              size="small"
              aria-label="Toggle file browser"
              color={activeTab.sftpOpen ? 'primary' : 'default'}
              onMouseEnter={() => void loadSftpPanel()}
              onFocus={() => void loadSftpPanel()}
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
            onMouseEnter={() => void loadForwardingPanel()}
            onFocus={() => void loadForwardingPanel()}
            onClick={() => setForwardingOpen(!forwardingOpen)}
          >
            <Badge badgeContent={activeForwards} color="success" max={99} slotProps={{ badge: { sx: { fontSize: 9, height: 14, minWidth: 14 } } }}>
              <SwapHorizOutlinedIcon fontSize="small" />
            </Badge>
          </IconButton>
        </Tooltip>
        {terminalReady && (
          <Tooltip title="Terminal actions">
            <IconButton size="small" aria-label="Terminal actions" onClick={(e) => setTerminalMenu(e.currentTarget)}>
              <TerminalIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Session history">
          <IconButton
            size="small"
            aria-label="Session history"
            onMouseEnter={() => void loadSessionHistoryDialog()}
            onFocus={() => void loadSessionHistoryDialog()}
            onClick={() => setHistoryOpen(true)}
          >
            <HistoryOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={`Appearance: ${currentAppearance.label}`}>
          <IconButton
            size="small"
            aria-label={`Appearance: ${currentAppearance.label}`}
            aria-controls={appearanceMenu ? 'appearance-menu' : undefined}
            aria-expanded={appearanceMenu ? 'true' : undefined}
            aria-haspopup="menu"
            onClick={(event) => setAppearanceMenu(event.currentTarget)}
          >
            {currentAppearance.icon}
          </IconButton>
        </Tooltip>
        <Tooltip title="Keyboard shortcuts">
          <IconButton
            size="small"
            aria-label="Keyboard shortcuts"
            onMouseEnter={() => void loadShortcutsDialog()}
            onFocus={() => void loadShortcutsDialog()}
            onClick={() => setShortcutsOpen(true)}
          >
            <KeyboardOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Settings">
          <IconButton
            size="small"
            aria-label="Settings"
            onMouseEnter={() => void loadSettingsDialog()}
            onFocus={() => void loadSettingsDialog()}
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Toolbar>

      <Menu
        id="appearance-menu"
        open={!!appearanceMenu}
        anchorEl={appearanceMenu}
        onClose={() => setAppearanceMenu(null)}
      >
        {APPEARANCE_OPTIONS.map((option) => (
          <MenuItem
            key={option.mode}
            selected={option.mode === mode}
            onClick={() => {
              setPrefs({ themeMode: option.mode });
              setAppearanceMenu(null);
            }}
          >
            <ListItemIcon>{option.icon}</ListItemIcon>
            <ListItemText>{option.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>

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
          <ChordHint chord={findChord} />
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
          <ChordHint chord={selectAllChord} />
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
        {activeTab?.loggingEnabled !== undefined ? <Divider /> : null}
        {activeTab?.loggingEnabled ? (
          <>
            <MenuItem
              onClick={() => {
                closeMenu();
                handle()?.setLogging({ enabled: false });
              }}
            >
              <ListItemIcon>
                <StopCircleOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Stop session logging</ListItemText>
            </MenuItem>
            <MenuItem
              onClick={() => {
                closeMenu();
                handle()?.setLogging({ paused: !activeTab.loggingPaused });
              }}
            >
              <ListItemIcon>
                {activeTab.loggingPaused ? (
                  <PlayCircleOutlineIcon fontSize="small" />
                ) : (
                  <PauseCircleOutlineIcon fontSize="small" />
                )}
              </ListItemIcon>
              <ListItemText>
                {activeTab.loggingPaused ? 'Resume session logging' : 'Pause session logging'}
              </ListItemText>
            </MenuItem>
          </>
        ) : activeTab?.loggingEnabled === false ? (
          <MenuItem
            onClick={() => {
              closeMenu();
              handle()?.setLogging({ enabled: true });
            }}
          >
            <ListItemIcon>
              <PlayCircleOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Start session logging</ListItemText>
          </MenuItem>
        ) : null}
        {activeTab?.loggingEnabled ? (
          <MenuItem
            onClick={() => {
              closeMenu();
              handle()?.setLogging({ captureInput: !activeTab.captureInput });
            }}
          >
            <ListItemIcon>
              {activeTab.captureInput ? (
                <VisibilityOffOutlinedIcon fontSize="small" />
              ) : (
                <KeyboardAltOutlinedIcon fontSize="small" />
              )}
            </ListItemIcon>
            <ListItemText>
              {activeTab.captureInput
                ? 'Suppress sensitive input'
                : 'Record input (may include secrets)'}
            </ListItemText>
          </MenuItem>
        ) : null}
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
          <ChordHint chord={clearChord} />
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
          <ChordHint chord={zoomInChord} />
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
          <ChordHint chord={zoomOutChord} />
        </MenuItem>
        <MenuItem
          onClick={() => {
            handle()?.zoomReset();
            setZoomTick((n) => n + 1);
          }}
        >
          <ListItemIcon sx={{ fontSize: 12 }}>{`${handle()?.zoomPercent() ?? 100}%`}</ListItemIcon>
          <ListItemText>Reset zoom</ListItemText>
          <ChordHint chord={zoomResetChord} />
        </MenuItem>
      </Menu>
    </AppBar>
  );
});
