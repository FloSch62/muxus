import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import HorizontalSplitOutlinedIcon from '@mui/icons-material/HorizontalSplitOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import VerticalSplitOutlinedIcon from '@mui/icons-material/VerticalSplitOutlined';
import PodcastsOutlinedIcon from '@mui/icons-material/PodcastsOutlined';
import {
  duplicateTab,
  openEmptyTab,
  openTabInNewWindow,
  requestClosePane,
  requestCloseTabs,
} from '../session-actions.js';
import { useTabsStore, type TabStatus, type TerminalTab } from '../state/tabs.js';
import { findPane } from '../state/workspace-layout.js';
import { layout, statusTextColor } from '../theme.js';
import { useMultiExecStore } from '../state/multi-exec.js';

const statusDot: Record<TabStatus, 'warning' | 'success' | 'error'> = {
  connecting: 'warning',
  connected: 'success',
  closed: 'error',
};

/** Color flags a tab can be marked with (context menu). */
const TAB_FLAG_COLORS = ['#ef5350', '#ffa726', '#ffee58', '#66bb6a', '#26c6da', '#42a5f5', '#ab47bc', '#ec407a'];

/** Browser-style terminal tab strip scoped to one split pane. */
export function TabStrip({ paneId, focused }: { paneId: string; focused: boolean }) {
  const allTabs = useTabsStore((s) => s.tabs);
  const tabs = allTabs.filter((tab) => tab.paneId === paneId);
  const activeId = useTabsStore((s) => findPane(s.root, paneId)?.activeTabId ?? null);
  const canClosePane = useTabsStore((s) => s.root.type === 'split');
  const activate = useTabsStore((s) => s.activate);
  const focusPane = useTabsStore((s) => s.focusPane);
  const split = useTabsStore((s) => s.split);
  const update = useTabsStore((s) => s.update);
  const multiExecTargets = useMultiExecStore((s) => s.selectedIds);
  const toggleMultiExecTarget = useMultiExecStore((s) => s.toggleTarget);
  const [menu, setMenu] = useState<{ position: { top: number; left: number }; tab: TerminalTab } | null>(null);
  const [renaming, setRenaming] = useState<TerminalTab | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) return;
    requestAnimationFrame(() => renameInputRef.current?.select());
  }, [renaming]);

  const openMenu = (tab: TerminalTab, position: { top: number; left: number }) => setMenu({ position, tab });
  const menuTab = menu ? allTabs.find((t) => t.id === menu.tab.id) : undefined;

  const commitRename = () => {
    if (renaming && renameValue.trim()) update(renaming.id, { title: renameValue.trim() });
    setRenaming(null);
  };

  return (
    <Stack
      direction="row"
      sx={{
        height: layout.tabStripHeight,
        flexShrink: 0,
        alignItems: 'stretch',
        bgcolor: 'sidebar',
        borderBottom: 1,
        borderColor: 'divider',
        overflowX: 'auto',
        scrollbarWidth: 'none',
        transition: (theme) => theme.transitions.create('border-color', {
          duration: theme.transitions.duration.shortest,
        }),
        ...(focused && {
          borderBottomColor: (theme) => alpha(theme.palette.text.primary, 0.18),
        }),
      }}
      onPointerDown={() => focusPane(paneId)}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <Stack
            key={tab.id}
            direction="row"
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => activate(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') activate(tab.id);
            }}
            onAuxClick={(e) => {
              // Middle-click closes, the browser-tab convention.
              if (e.button === 1) requestCloseTabs([tab.id]);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(tab, { top: e.clientY, left: e.clientX });
            }}
            onDoubleClick={() => {
              setRenameValue(tab.title);
              setRenaming(tab);
            }}
            sx={(theme) => ({
              alignItems: 'center',
              gap: 0.75,
              px: 1.25,
              minWidth: 0,
              maxWidth: 220,
              position: 'relative',
              cursor: 'pointer',
              userSelect: 'none',
              borderRight: 1,
              borderColor: 'divider',
              borderTop: 2,
              borderTopColor: tab.color ?? 'transparent',
              bgcolor: active ? 'background.default' : 'transparent',
              borderBottom: active ? 'none' : undefined,
              backgroundImage: active && focused
                ? `linear-gradient(180deg, ${alpha(theme.palette.primary.main, 0.1)}, transparent 72%)`
                : 'none',
              transition: theme.transitions.create(['background-color', 'color'], {
                duration: theme.transitions.duration.shortest,
              }),
              '&::after': {
                content: '""',
                position: 'absolute',
                left: 10,
                right: 10,
                bottom: 0,
                height: 2,
                borderRadius: '2px 2px 0 0',
                bgcolor: 'primary.main',
                boxShadow: `0 -1px 8px ${alpha(theme.palette.primary.main, 0.32)}`,
                opacity: active && focused ? 1 : 0,
                transform: active && focused ? 'scaleX(1)' : 'scaleX(0.55)',
                transition: theme.transitions.create(['opacity', 'transform'], {
                  duration: theme.transitions.duration.shortest,
                }),
              },
              '&:focus-visible': {
                outline: 'none',
                boxShadow: `inset 0 0 0 1px ${alpha(theme.palette.text.primary, 0.35)}`,
              },
              '&:hover .muxus-tab-close': { visibility: 'visible' },
            })}
          >
            {tab.profile === null ? (
              <AddIcon sx={{ fontSize: 15, color: active && focused ? 'primary.main' : 'text.secondary' }} />
            ) : tab.profile.kind === 'local' ? (
              <TerminalIcon sx={{ fontSize: 15, color: active && focused ? 'primary.main' : 'text.secondary' }} />
            ) : (
              <DnsOutlinedIcon sx={{ fontSize: 15, color: active && focused ? 'primary.main' : 'text.secondary' }} />
            )}
            <Typography
              variant="body2"
              noWrap
              sx={{
                fontWeight: active && focused ? 600 : 500,
                color: active ? 'text.primary' : 'text.secondary',
                flex: 1,
                minWidth: 0,
              }}
            >
              {tab.title}
            </Typography>
            {multiExecTargets.includes(tab.id) && (
              <Tooltip
                title={
                  multiExecTargets.length >= 2
                    ? 'Input is mirrored with this terminal'
                    : 'Selected for multi-execution'
                }
              >
                <PodcastsOutlinedIcon
                  color={multiExecTargets.length >= 2 ? 'warning' : 'disabled'}
                  sx={{ fontSize: 14, flexShrink: 0 }}
                />
              </Tooltip>
            )}
            {tab.status !== 'idle' && (
              <Box
                sx={(theme) => ({
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  flexShrink: 0,
                  bgcolor: statusTextColor(statusDot[tab.status])(theme),
                })}
              />
            )}
            <IconButton
              className="muxus-tab-close"
              size="small"
              aria-label={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                requestCloseTabs([tab.id]);
              }}
              sx={{ p: 0.25, visibility: active ? 'visible' : 'hidden' }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Stack>
        );
      })}
      <Tooltip title="New tab (Ctrl+Shift+T)">
        <IconButton
          size="small"
          aria-label="New tab"
          onClick={() => {
            focusPane(paneId);
            openEmptyTab();
          }}
          sx={{ alignSelf: 'center', ml: 0.5 }}
        >
          <AddIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Box sx={{ flex: 1, minWidth: 4 }} />
      <Tooltip title="Split right">
        <IconButton
          size="small"
          aria-label="Split pane right"
          onClick={() => split(paneId, 'horizontal')}
          sx={{ alignSelf: 'center' }}
        >
          <VerticalSplitOutlinedIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Split down">
        <IconButton
          size="small"
          aria-label="Split pane down"
          onClick={() => split(paneId, 'vertical')}
          sx={{ alignSelf: 'center' }}
        >
          <HorizontalSplitOutlinedIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
      {canClosePane && (
        <Tooltip title="Close pane">
          <IconButton
            size="small"
            aria-label="Close pane"
            onClick={() => requestClosePane(paneId)}
            sx={{ alignSelf: 'center', mr: 0.5 }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}

      <Menu
        open={!!menu}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu?.position}
      >
        <MenuItem
          onClick={() => {
            if (menuTab) {
              setRenameValue(menuTab.title);
              setRenaming(menuTab);
            }
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <DriveFileRenameOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Rename tab</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={!menuTab?.profile}
          onClick={() => {
            if (menuTab) duplicateTab(menuTab.id);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Duplicate (new session)</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={!menuTab?.profile}
          onClick={() => {
            if (menuTab) openTabInNewWindow(menuTab.id);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <OpenInNewOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Open in new window</ListItemText>
        </MenuItem>
        <Divider />
        <Box sx={{ px: 2, py: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Flag
          </Typography>
          <Stack direction="row" spacing={0.5}>
            {TAB_FLAG_COLORS.map((color) => (
              <ButtonBase
                key={color}
                aria-label={`Flag tab ${color}`}
                onClick={() => {
                  if (menuTab) update(menuTab.id, { color: menuTab.color === color ? undefined : color });
                  setMenu(null);
                }}
                sx={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  bgcolor: color,
                  '&:hover': { transform: 'scale(1.15)' },
                }}
              >
                {menuTab?.color === color && <CheckIcon sx={{ fontSize: 13, color: 'rgba(0,0,0,0.7)' }} />}
              </ButtonBase>
            ))}
            <Tooltip title="No flag">
              <ButtonBase
                aria-label="Remove tab flag"
                onClick={() => {
                  if (menuTab) update(menuTab.id, { color: undefined });
                  setMenu(null);
                }}
                sx={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  border: 1,
                  borderColor: 'divider',
                  '&:hover': { transform: 'scale(1.15)' },
                }}
              >
                {!menuTab?.color && <CheckIcon sx={{ fontSize: 13, color: 'text.disabled' }} />}
              </ButtonBase>
            </Tooltip>
          </Stack>
        </Box>
        <Divider />
        <MenuItem
          disabled={menuTab?.status !== 'connected'}
          onClick={() => {
            if (menuTab) toggleMultiExecTarget(menuTab.id);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <PodcastsOutlinedIcon fontSize="small" color={menuTab && multiExecTargets.includes(menuTab.id) ? 'warning' : 'inherit'} />
          </ListItemIcon>
          <ListItemText>
            {menuTab && multiExecTargets.includes(menuTab.id) ? 'Remove from multi-execution' : 'Add to multi-execution'}
          </ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            if (menuTab) requestCloseTabs([menuTab.id]);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <CloseIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Close tab</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={tabs.length < 2}
          onClick={() => {
            if (menuTab) requestCloseTabs(tabs.filter((t) => t.id !== menuTab.id).map((t) => t.id));
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <CloseIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Close other tabs</ListItemText>
        </MenuItem>
      </Menu>

      <Dialog open={!!renaming} onClose={() => setRenaming(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Rename tab</DialogTitle>
        <DialogContent>
          <TextField
            inputRef={renameInputRef}
            fullWidth
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
            }}
            sx={{ mt: 0.5 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenaming(null)}>Cancel</Button>
          <Button variant="contained" disabled={!renameValue.trim()} onClick={commitRename}>
            Rename
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
