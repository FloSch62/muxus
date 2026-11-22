import { memo, useLayoutEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
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
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import CenterFocusStrongOutlinedIcon from '@mui/icons-material/CenterFocusStrongOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FullscreenExitOutlinedIcon from '@mui/icons-material/FullscreenExitOutlined';
import KeyboardAltOutlinedIcon from '@mui/icons-material/KeyboardAltOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import WorkspacesOutlinedIcon from '@mui/icons-material/WorkspacesOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutlineOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutlineOutlined';
import PowerInputOutlinedIcon from '@mui/icons-material/PowerInputOutlined';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { copyToClipboard } from '../clipboard.js';
import { layout } from '../theme.js';
import { setTitleBarHeight } from '../titlebar-overlay.js';
import { useChordLabel } from '../keymap/hints.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { requestLogSessionToFile } from '../session-actions.js';
import { showToast } from '../state/toast.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { useWorkspacesStore } from '../state/workspaces.js';
import { canSendBreak, isLineSession, sendBreak, supportsBreak } from '../terminal/send-break.js';
import { canSendTextFile, requestSendTextFile } from '../terminal/send-text-file.js';
import { terminalHandle } from '../terminal/terminal-registry.js';
import { ChordHint, withChord } from '../components/ChordHint.js';
import { MultiExecControl } from '../components/MultiExecControl.js';
import { loadCommandButtonsDialog, loadWorkspaceDialog } from '../lazy-features.js';

export const TopBar = memo(function TopBar() {
  const sidebarCollapsed = usePrefsStore((s) => s.sidebarCollapsed);
  const setPrefs = usePrefsStore((s) => s.set);
  const focusMode = useUiStore((s) => s.focusMode);
  const setFocusMode = useUiStore((s) => s.setFocusMode);
  const setCommandButtonsOpen = useUiStore((s) => s.setCommandButtonsOpen);
  const setWorkspacesOpen = useUiStore((s) => s.setWorkspacesOpen);
  const workspaceName = useWorkspacesStore((s) => s.activeName);
  const workspacesReady = useWorkspacesStore((s) => s.ready);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const requestSearch = useTabsStore((s) => s.requestSearch);
  const terminalReady = !!activeTab?.profile;
  const [terminalMenu, setTerminalMenu] = useState<HTMLElement | null>(null);
  const focusModeChord = useChordLabel('app.focus-mode');
  const sidebarChord = useChordLabel('app.sidebar');
  const findChord = useChordLabel('terminal.find');
  const selectAllChord = useChordLabel('terminal.select-all');
  const clearChord = useChordLabel('terminal.clear');
  const zoomInChord = useChordLabel('terminal.zoom-in');
  const zoomOutChord = useChordLabel('terminal.zoom-out');
  const zoomResetChord = useChordLabel('terminal.zoom-reset');
  const sendBreakChord = useChordLabel('terminal.send-break');
  const sendTextFileChord = useChordLabel('terminal.send-text-file');
  // Re-render hook so the zoom percentage in the open menu stays current.
  const [, setZoomTick] = useState(0);

  const handle = () => terminalHandle(activeTab?.id);
  const closeMenu = () => setTerminalMenu(null);
  const toggleFocusMode = () => setFocusMode(!focusMode);
  useLayoutEffect(() => {
    // Focus mode can be entered through the global shortcut while a portaled
    // menu is open. Clear both anchors before paint for every entry path.
    if (focusMode) setTerminalMenu(null);
    setTitleBarHeight(focusMode ? layout.focusTopBarHeight : layout.topBarHeight);
  }, [focusMode]);

  return (
    <AppBar position="static" color="transparent">
      {/* In the desktop app the window is frameless and this toolbar doubles as
          the titlebar: it is a drag region, and the env(titlebar-area-*) vars
          reserve space for the native window controls (traffic lights on the
          left on macOS, min/max/close on the right on Windows/Linux). In a
          regular browser the env() fallbacks make all of this a no-op. */}
      <Toolbar
        variant="dense"
        sx={{
          gap: 1.5,
          WebkitAppRegion: 'drag',
          // Double the specificity so MUI's responsive height and gutter rules
          // cannot make the compact focus-mode titlebar grow again.
          '&&': {
            minHeight: focusMode ? layout.focusTopBarHeight : layout.topBarHeight,
            pl: 'calc(env(titlebar-area-x, 0px) + 16px)',
            pr: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 16px)',
          },
          '& button, & input, & a, & [role="button"]': {
            WebkitAppRegion: 'no-drag',
          },
          ...(focusMode
            ? { '& > :not([data-focus-mode-control])': { display: 'none' } }
            : {}),
        }}
      >
        <Box data-focus-mode-control sx={{ flex: 1, display: focusMode ? 'block' : 'none' }} />
        <Tooltip
          title={withChord(`${sidebarCollapsed ? 'Show' : 'Hide'} sidebar`, sidebarChord)}
        >
          <IconButton size="small" aria-label="Toggle sidebar" onClick={() => setPrefs({ sidebarCollapsed: !sidebarCollapsed })} sx={{ mr: 0.5 }}>
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
        {terminalReady && (
          <Tooltip title="Terminal actions">
            <IconButton size="small" aria-label="Terminal actions" onClick={(e) => setTerminalMenu(e.currentTarget)}>
              <TerminalIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={withChord(focusMode ? 'Exit focus mode' : 'Enter focus mode', focusModeChord)}>
          <IconButton
            data-focus-mode-control
            size="small"
            aria-label={focusMode ? 'Exit focus mode' : 'Enter focus mode'}
            color={focusMode ? 'primary' : 'default'}
            onClick={toggleFocusMode}
          >
            {focusMode ? (
              <FullscreenExitOutlinedIcon fontSize="small" />
            ) : (
              <CenterFocusStrongOutlinedIcon fontSize="small" />
            )}
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
        {activeTab?.loggingEnabled !== undefined ? (
          <MenuItem
            onClick={() => {
              closeMenu();
              handle()?.setLogging({ enabled: !activeTab.loggingEnabled });
            }}
          >
            <ListItemIcon>
              {activeTab.loggingEnabled ? (
                <StopCircleOutlinedIcon fontSize="small" />
              ) : (
                <PlayCircleOutlineIcon fontSize="small" />
              )}
            </ListItemIcon>
            <ListItemText>
              {activeTab.loggingEnabled ? 'Stop session logging' : 'Start session logging'}
            </ListItemText>
          </MenuItem>
        ) : null}
        {activeTab?.loggingEnabled !== undefined ? (
          <MenuItem
            onClick={() => {
              closeMenu();
              if (activeTab.logFilePath) handle()?.setLogging({ logToFile: false });
              else void requestLogSessionToFile(activeTab.id);
            }}
          >
            <ListItemIcon>
              {activeTab.logFilePath ? (
                <StopCircleOutlinedIcon fontSize="small" />
              ) : (
                <EditNoteOutlinedIcon fontSize="small" />
              )}
            </ListItemIcon>
            <ListItemText>
              {activeTab.logFilePath ? 'Stop logging to file' : 'Log session to file…'}
            </ListItemText>
          </MenuItem>
        ) : null}
        {activeTab?.logFilePath && window.muxusDesktop ? (
          <MenuItem
            onClick={() => {
              closeMenu();
              window.muxusDesktop?.showItemInFolder(activeTab.logFilePath!);
            }}
          >
            <ListItemIcon>
              <FolderOpenOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Show log file</ListItemText>
          </MenuItem>
        ) : null}
        {activeTab?.loggingEnabled || activeTab?.logFilePath ? (
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
        ) : null}
        {activeTab?.loggingEnabled || activeTab?.logFilePath ? (
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
        {isLineSession(activeTab) ? <Divider /> : null}
        {supportsBreak(activeTab) ? (
          <MenuItem
            disabled={!canSendBreak(activeTab)}
            onClick={() => {
              closeMenu();
              sendBreak(activeTab);
            }}
          >
            <ListItemIcon>
              <PowerInputOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Send BREAK</ListItemText>
            <ChordHint chord={sendBreakChord} />
          </MenuItem>
        ) : null}
        {isLineSession(activeTab) ? (
          <MenuItem
            disabled={!canSendTextFile(activeTab)}
            onClick={() => {
              closeMenu();
              requestSendTextFile(activeTab?.id);
            }}
          >
            <ListItemIcon>
              <UploadFileOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Send text file…</ListItemText>
            <ChordHint chord={sendTextFileChord} />
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
