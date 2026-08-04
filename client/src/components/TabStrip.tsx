import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
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
import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import CloseFullscreenOutlinedIcon from '@mui/icons-material/CloseFullscreenOutlined';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import HorizontalSplitOutlinedIcon from '@mui/icons-material/HorizontalSplitOutlined';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import OpenInFullOutlinedIcon from '@mui/icons-material/OpenInFullOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutlineOutlined';
import ReplayOutlinedIcon from '@mui/icons-material/ReplayOutlined';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import VerticalSplitOutlinedIcon from '@mui/icons-material/VerticalSplitOutlined';
import PodcastsOutlinedIcon from '@mui/icons-material/PodcastsOutlined';
import { useChordLabel } from '../keymap/hints.js';
import { ChordHint, withChord } from './ChordHint.js';
import {
  duplicateTab,
  openEmptyTab,
  openTabInNewWindow,
  requestClosePane,
  requestCloseTabs,
  splitActivePane,
} from '../session-actions.js';
import {
  useTabsStore,
  type PaneDirection,
  type TabStatus,
  type TerminalTab,
} from '../state/tabs.js';
import { findPane } from '../state/workspace-layout.js';
import { layout, statusTextColor } from '../theme.js';
import { useMultiExecStore } from '../state/multi-exec.js';
import { terminalHandle } from '../terminal/terminal-registry.js';
import { hostKindIcon } from './host-kind-icon.js';
import {
  activeTabTransfer,
  beginTabDrag,
  endTabDrag,
  hasTabTransfer,
  readTabTransfer,
  writeTabTransfer,
} from '../tab-drag.js';

const loadTabTransfer = () => import('../tab-transfer.js');

const statusDot: Record<TabStatus, 'warning' | 'success' | 'error'> = {
  connecting: 'warning',
  connected: 'success',
  interrupted: 'warning',
  closed: 'error',
};

/** Color flags a tab can be marked with (context menu). */
const TAB_FLAG_COLORS = ['#ef5350', '#ffa726', '#ffee58', '#66bb6a', '#26c6da', '#42a5f5', '#ab47bc', '#ec407a'];

/** Which side of the hovered tab a drop at this pointer position lands on. */
function dropEdge(event: DragEvent<HTMLElement>): 'before' | 'after' {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
}

function PinIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M9 2h6v8l4 3v2h-6v7h-2v-7H5v-2l4-3z" />
    </SvgIcon>
  );
}

/** Browser-style terminal tab strip scoped to one split pane. */
export function TabStrip({
  paneId,
  tabNumberById,
  focused,
  zoomed,
}: {
  paneId: string;
  tabNumberById: ReadonlyMap<string, number>;
  focused: boolean;
  zoomed: boolean;
}) {
  const allTabs = useTabsStore((s) => s.tabs);
  const unreadOutputIds = useTabsStore((s) => s.unreadOutputIds);
  const tabs = allTabs.filter((tab) => tab.paneId === paneId);
  const activeId = useTabsStore((s) => findPane(s.root, paneId)?.activeTabId ?? null);
  const canClosePane = useTabsStore((s) => s.root.type === 'split');
  const activate = useTabsStore((s) => s.activate);
  const focusPane = useTabsStore((s) => s.focusPane);
  const toggleZoom = useTabsStore((s) => s.toggleZoom);
  const equalizePanes = useTabsStore((s) => s.equalizePanes);
  const update = useTabsStore((s) => s.update);
  const setPinned = useTabsStore((s) => s.setPinned);
  const moveTabToNewPane = useTabsStore((s) => s.moveTabToNewPane);
  const reconnect = useTabsStore((s) => s.reconnect);
  const multiExecTargets = useMultiExecStore((s) => s.selectedIds);
  const multiExecSelected = new Set(multiExecTargets);
  const toggleMultiExecTarget = useMultiExecStore((s) => s.toggleTarget);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** Insertion line for drops arriving from another pane or window; null targetId = end of strip. */
  const [dropIndicator, setDropIndicator] = useState<
    { targetId: string | null; edge: 'before' | 'after' } | null
  >(null);
  const tabElements = useRef(new Map<string, HTMLElement>());
  const flipLefts = useRef(new Map<string, number>());
  /** Hovered midpoints are unreliable while tabs are sliding; pause live resorting until then. */
  const settleUntil = useRef(0);
  const orderKey = tabs.map((tab) => tab.id).join('\n');
  const previousOrderKey = useRef(orderKey);
  const [menu, setMenu] = useState<{ position: { top: number; left: number }; tab: TerminalTab } | null>(null);
  const [paneMenu, setPaneMenu] = useState<{ top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState<TerminalTab | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newTabChord = useChordLabel('tab.new');
  const splitRightChord = useChordLabel('pane.split.right');
  const splitDownChord = useChordLabel('pane.split.down');
  const splitLeftChord = useChordLabel('pane.split.left');
  const splitUpChord = useChordLabel('pane.split.up');
  const zoomChord = useChordLabel('pane.zoom');
  const closePaneChord = useChordLabel('pane.close');

  const splitPane = (direction: PaneDirection) => {
    focusPane(paneId);
    splitActivePane(direction);
  };

  useEffect(() => {
    if (!renaming) return;
    requestAnimationFrame(() => renameInputRef.current?.select());
  }, [renaming]);

  // FLIP: when this pane's tab order changes (live drag resorting, reorder
  // chords, drops), slide each tab from its previous slot instead of teleporting.
  useLayoutEffect(() => {
    const moved = previousOrderKey.current !== orderKey;
    previousOrderKey.current = orderKey;
    const lefts = flipLefts.current;
    for (const id of lefts.keys()) {
      if (!tabElements.current.has(id)) lefts.delete(id);
    }
    for (const [id, element] of tabElements.current) {
      // offsetLeft is the layout slot: unaffected by strip scroll and by a
      // still-running slide, so back-to-back reorders start from the truth.
      const left = element.offsetLeft;
      const from = lefts.get(id);
      if (moved && from !== undefined && from !== left && typeof element.animate === 'function') {
        element.animate(
          [{ transform: `translateX(${from - left}px)` }, { transform: 'none' }],
          { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
        );
        settleUntil.current = performance.now() + 170;
      }
      lefts.set(id, left);
    }
  });

  const openMenu = (tab: TerminalTab, position: { top: number; left: number }) => setMenu({ position, tab });
  const menuTab = menu ? allTabs.find((t) => t.id === menu.tab.id) : undefined;
  const menuTabSupportsSftp =
    menuTab?.profile?.kind === 'ssh' &&
    (menuTab.status === 'connecting' || menuTab.status === 'connected') &&
    menuTab.sftpAvailable !== false;
  const canSplitMenuTab = !!menuTab && allTabs.some(
    (tab) => tab.paneId === menuTab.paneId && tab.id !== menuTab.id,
  );

  const commitRename = () => {
    if (renaming && renameValue.trim()) update(renaming.id, { title: renameValue.trim() });
    setRenaming(null);
  };

  const dropTab = (
    transferId: string,
    targetId?: string,
    edge: 'before' | 'after' = 'after',
  ) => {
    const local = activeTabTransfer();
    if (local?.transferId === transferId) {
      useTabsStore.getState().moveTabToPane(local.tabId, paneId, targetId, edge);
      endTabDrag(transferId);
      void loadTabTransfer().then((module) => module.finishLocalTabTransfer(transferId));
      return;
    }
    void loadTabTransfer().then((module) =>
      module.receiveTabTransfer(transferId, paneId, targetId, edge),
    );
  };

  return (
    <Stack
      direction="row"
      role="tablist"
      aria-label="Terminal tabs"
      tabIndex={-1}
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
      onDragOver={(event) => {
        if (!hasTabTransfer(event.dataTransfer)) return;
        if ((event.target as HTMLElement).closest('[data-muxus-tab]')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const local = activeTabTransfer();
        const dragged = local
          ? allTabs.find((candidate) => candidate.id === local.tabId)
          : undefined;
        if (dragged?.paneId === paneId) {
          // Hovering past the last tab sends a same-strip drag to the end of
          // its group live; the moving tab is its own indicator.
          setDropIndicator(null);
          if (performance.now() >= settleUntil.current) {
            useTabsStore.getState().moveTabToPane(dragged.id, paneId);
          }
          return;
        }
        setDropIndicator((current) =>
          current?.targetId === null ? current : { targetId: null, edge: 'after' },
        );
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropIndicator(null);
        }
      }}
      onDrop={(event) => {
        setDropIndicator(null);
        if ((event.target as HTMLElement).closest('[data-muxus-tab]')) return;
        const transferId = readTabTransfer(event.dataTransfer);
        if (!transferId) return;
        event.preventDefault();
        dropTab(transferId);
      }}
      onPointerDown={() => focusPane(paneId)}
      onContextMenu={(e) => {
        // Tabs handle their own menu first; this one belongs to the pane.
        if (e.defaultPrevented) return;
        e.preventDefault();
        focusPane(paneId);
        setPaneMenu({ top: e.clientY, left: e.clientX });
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const tabNumber = tabNumberById.get(tab.id);
        const hasUnreadOutput = unreadOutputIds.has(tab.id);
        const TabIcon =
          tab.profile === null
            ? AddIcon
            : tab.profile.kind === 'local'
              ? TerminalIcon
              : hostKindIcon(tab.profile.kind);
        return (
          <Stack
            key={tab.id}
            data-muxus-tab={tab.id}
            direction="row"
            role="tab"
            aria-selected={active}
            aria-label={[
              tab.title,
              tab.pinned ? 'pinned' : '',
              hasUnreadOutput ? 'new terminal output' : '',
            ].filter(Boolean).join(', ')}
            tabIndex={0}
            draggable
            ref={(element: HTMLElement | null) => {
              if (element) tabElements.current.set(tab.id, element);
              else tabElements.current.delete(tab.id);
            }}
            onDragStart={(event) => {
              const transferId = beginTabDrag(tab.id);
              void loadTabTransfer().then((module) =>
                module.registerTabTransferSource(transferId, tab.id),
              );
              event.dataTransfer.effectAllowed = 'move';
              writeTabTransfer(event.dataTransfer, transferId);
              // After the browser snapshots the drag image, dim the strip copy.
              requestAnimationFrame(() => setDraggingId(tab.id));
            }}
            onDragOver={(event) => {
              if (!hasTabTransfer(event.dataTransfer)) return;
              const local = activeTabTransfer();
              const dragged = local
                ? allTabs.find((candidate) => candidate.id === local.tabId)
                : undefined;
              if (
                dragged?.paneId === paneId &&
                !!dragged.pinned !== !!tab.pinned
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              if (dragged?.paneId === paneId) {
                // Same-strip drags resort live, browser style; the moving tab
                // is its own indicator.
                setDropIndicator(null);
                if (dragged.id !== tab.id && performance.now() >= settleUntil.current) {
                  useTabsStore.getState().reorderTab(dragged.id, tab.id, dropEdge(event));
                }
                return;
              }
              const edge = dropEdge(event);
              setDropIndicator((current) =>
                current?.targetId === tab.id && current.edge === edge
                  ? current
                  : { targetId: tab.id, edge },
              );
            }}
            onDrop={(event) => {
              const transferId = readTabTransfer(event.dataTransfer);
              if (!transferId) return;
              event.preventDefault();
              event.stopPropagation();
              setDropIndicator(null);
              dropTab(transferId, tab.id, dropEdge(event));
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDropIndicator(null);
              const current = activeTabTransfer();
              if (current?.tabId === tab.id) endTabDrag(current.transferId);
            }}
            onClick={() => activate(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') activate(tab.id);
            }}
            onAuxClick={(e) => {
              // Middle-click closes, the browser-tab convention.
              if (e.button === 1) void requestCloseTabs([tab.id]);
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
              cursor: 'grab',
              userSelect: 'none',
              borderRight: 1,
              borderColor: 'divider',
              borderTop: 2,
              borderTopColor: tab.color ?? 'transparent',
              bgcolor: active
                ? 'background.default'
                : hasUnreadOutput
                  ? alpha(theme.palette.info.main, 0.12)
                  : 'transparent',
              borderBottom: active ? 'none' : undefined,
              backgroundImage: active && focused
                ? `linear-gradient(180deg, ${alpha(theme.palette.primary.main, 0.1)}, transparent 72%)`
                : hasUnreadOutput
                  ? `linear-gradient(180deg, ${alpha(theme.palette.info.main, 0.12)}, transparent 80%)`
                  : 'none',
              // The strip copy stays in place at low opacity while its drag
              // image follows the pointer, the way browser tabs behave.
              opacity: draggingId === tab.id ? 0.4 : 1,
              transition: theme.transitions.create(['background-color', 'color', 'opacity'], {
                duration: theme.transitions.duration.shortest,
              }),
              ...(dropIndicator?.targetId === tab.id && {
                '&::before': {
                  content: '""',
                  position: 'absolute',
                  [dropIndicator.edge === 'before' ? 'left' : 'right']: -1,
                  top: 7,
                  bottom: 7,
                  width: 2,
                  borderRadius: '1px',
                  bgcolor: 'primary.main',
                  boxShadow: `0 0 8px ${alpha(theme.palette.primary.main, 0.55)}`,
                  zIndex: 2,
                  pointerEvents: 'none',
                },
              }),
              '&::after': {
                content: '""',
                position: 'absolute',
                left: 10,
                right: 10,
                bottom: 0,
                height: 2,
                borderRadius: '2px 2px 0 0',
                bgcolor: hasUnreadOutput ? 'info.main' : 'primary.main',
                boxShadow: `0 -1px 8px ${alpha(
                  hasUnreadOutput ? theme.palette.info.main : theme.palette.primary.main,
                  0.32,
                )}`,
                opacity: (active && focused) || hasUnreadOutput ? 1 : 0,
                transform: (active && focused) || hasUnreadOutput ? 'scaleX(1)' : 'scaleX(0.55)',
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
            <Box
              component="span"
              sx={{ position: 'relative', display: 'flex', width: 18, flexShrink: 0 }}
            >
              <TabIcon
                className="muxus-tab-icon"
                sx={{
                  fontSize: 15,
                  color: hasUnreadOutput
                    ? 'info.main'
                    : active && focused
                      ? 'primary.main'
                      : 'text.secondary',
                }}
              />
              {tabNumber !== undefined ? (
                <Box
                  component="span"
                  className="muxus-tab-number"
                  aria-hidden
                  title={`Tab ${tabNumber}`}
                >
                  {tabNumber}
                </Box>
              ) : null}
              {hasUnreadOutput ? (
                <Box
                  component="span"
                  aria-label="New terminal output"
                  sx={{
                    position: 'absolute',
                    top: -2,
                    right: -3,
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    bgcolor: 'info.main',
                    boxShadow: (theme) => `0 0 0 2px ${theme.palette.sidebar}`,
                  }}
                />
              ) : null}
            </Box>
            <Typography
              variant="body2"
              noWrap
              sx={{
                // Flat weight on purpose: the underline, icon tint and lifted
                // background already mark the active tab, and a weight jump
                // would re-measure the title on every switch. Weight and
                // tracking follow the sidebar labels (treeLabelSx).
                fontWeight: 450,
                letterSpacing: -0.1,
                color: active ? 'text.primary' : hasUnreadOutput ? 'info.main' : 'text.secondary',
                flex: 1,
                minWidth: 0,
              }}
            >
              {tab.title}
            </Typography>
            {tab.pinned ? (
              <PinIcon
                aria-label="Pinned"
                sx={{ fontSize: 13, flexShrink: 0, color: 'text.secondary' }}
              />
            ) : null}
            {multiExecSelected.has(tab.id) && (
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
              <Tooltip
                title={
                  tab.status === 'closed' && tab.failureReason
                    ? tab.failureReason
                    : tab.status === 'interrupted'
                      ? tab.failureReason ?? 'Connection interrupted'
                    : tab.status === 'connected'
                      ? 'Connected'
                      : tab.status === 'connecting'
                        ? 'Connecting'
                        : 'Disconnected'
                }
              >
                {tab.status === 'closed' ? (
                  <LinkOffOutlinedIcon
                    aria-label="Disconnected"
                    sx={{ color: 'error.main', fontSize: 15, flexShrink: 0 }}
                  />
                ) : (
                  <Box
                    component="span"
                    aria-label={
                      tab.status === 'interrupted'
                        ? 'Connection interrupted'
                        : tab.status === 'connecting'
                          ? 'Connecting'
                          : 'Connected'
                    }
                    sx={(theme) => ({
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      flexShrink: 0,
                      bgcolor: statusTextColor(statusDot[tab.status])(theme),
                    })}
                  />
                )}
              </Tooltip>
            )}
            <IconButton
              className="muxus-tab-close"
              size="small"
              aria-label={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                void requestCloseTabs([tab.id]);
              }}
              sx={{ p: 0.25, visibility: active ? 'visible' : 'hidden' }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Stack>
        );
      })}
      {dropIndicator?.targetId === null ? (
        <Box
          data-muxus-drop-indicator="end"
          sx={(theme) => ({
            width: 2,
            flexShrink: 0,
            alignSelf: 'stretch',
            my: '7px',
            ml: '-1px',
            borderRadius: '1px',
            bgcolor: 'primary.main',
            boxShadow: `0 0 8px ${alpha(theme.palette.primary.main, 0.55)}`,
            pointerEvents: 'none',
          })}
        />
      ) : null}
      <Tooltip title={withChord('New tab', newTabChord)}>
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
      <Tooltip title={withChord('Split right', splitRightChord)}>
        <IconButton
          size="small"
          aria-label="Split pane right"
          onClick={() => splitPane('right')}
          sx={{ alignSelf: 'center' }}
        >
          <VerticalSplitOutlinedIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={withChord('Split down', splitDownChord)}>
        <IconButton
          size="small"
          aria-label="Split pane down"
          onClick={() => splitPane('down')}
          sx={{ alignSelf: 'center' }}
        >
          <HorizontalSplitOutlinedIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
      {canClosePane && (
        <Tooltip title={withChord(zoomed ? 'Restore layout' : 'Zoom pane', zoomChord)}>
          <IconButton
            size="small"
            aria-label={zoomed ? 'Restore pane layout' : 'Zoom pane'}
            onClick={() => toggleZoom(paneId)}
            sx={{ alignSelf: 'center', color: zoomed ? 'primary.main' : undefined }}
          >
            {zoomed ? (
              <CloseFullscreenOutlinedIcon sx={{ fontSize: 15 }} />
            ) : (
              <OpenInFullOutlinedIcon sx={{ fontSize: 15 }} />
            )}
          </IconButton>
        </Tooltip>
      )}
      {canClosePane && (
        <Tooltip title={withChord('Close pane', closePaneChord)}>
          <IconButton
            size="small"
            aria-label="Close pane"
            onClick={() => void requestClosePane(paneId)}
            sx={{ alignSelf: 'center', mr: 0.5 }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}

      <Menu
        open={!!paneMenu}
        onClose={() => setPaneMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={paneMenu ?? undefined}
      >
        <MenuItem
          onClick={() => {
            setPaneMenu(null);
            splitPane('right');
          }}
        >
          <ListItemIcon>
            <VerticalSplitOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Split right</ListItemText>
          <ChordHint chord={splitRightChord} />
        </MenuItem>
        <MenuItem
          onClick={() => {
            setPaneMenu(null);
            splitPane('down');
          }}
        >
          <ListItemIcon>
            <HorizontalSplitOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Split down</ListItemText>
          <ChordHint chord={splitDownChord} />
        </MenuItem>
        <MenuItem
          onClick={() => {
            setPaneMenu(null);
            splitPane('left');
          }}
        >
          <ListItemIcon>
            <VerticalSplitOutlinedIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText>Split left</ListItemText>
          <ChordHint chord={splitLeftChord} />
        </MenuItem>
        <MenuItem
          onClick={() => {
            setPaneMenu(null);
            splitPane('up');
          }}
        >
          <ListItemIcon>
            <HorizontalSplitOutlinedIcon fontSize="small" sx={{ transform: 'scaleY(-1)' }} />
          </ListItemIcon>
          <ListItemText>Split up</ListItemText>
          <ChordHint chord={splitUpChord} />
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={!canClosePane}
          onClick={() => {
            setPaneMenu(null);
            toggleZoom(paneId);
          }}
        >
          <ListItemIcon>
            {zoomed ? (
              <CloseFullscreenOutlinedIcon fontSize="small" />
            ) : (
              <OpenInFullOutlinedIcon fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText>{zoomed ? 'Restore layout' : 'Zoom pane'}</ListItemText>
          <ChordHint chord={zoomChord} />
        </MenuItem>
        <MenuItem
          disabled={!canClosePane}
          onClick={() => {
            setPaneMenu(null);
            equalizePanes();
          }}
        >
          <ListItemIcon>
            <GridViewOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Even out panes</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={!canClosePane}
          onClick={() => {
            setPaneMenu(null);
            void requestClosePane(paneId);
          }}
        >
          <ListItemIcon>
            <CloseIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Close pane</ListItemText>
          <ChordHint chord={closePaneChord} />
        </MenuItem>
      </Menu>

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
          onClick={() => {
            if (menuTab) setPinned(menuTab.id, !menuTab.pinned);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <PinIcon
              fontSize="small"
              sx={{ transform: menuTab?.pinned ? 'rotate(45deg)' : undefined }}
            />
          </ListItemIcon>
          <ListItemText>{menuTab?.pinned ? 'Unpin tab' : 'Pin tab'}</ListItemText>
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
        {menuTabSupportsSftp ? (
          <MenuItem
            onClick={() => {
              update(menuTab.id, { sftpOpen: true });
              activate(menuTab.id);
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <FolderOutlinedIcon fontSize="small" />
            </ListItemIcon>
            Open SFTP file browser
          </MenuItem>
        ) : null}
        <Divider />
        <MenuItem
          disabled={!canSplitMenuTab}
          onClick={() => {
            if (menuTab) moveTabToNewPane(menuTab.id, 'right');
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <VerticalSplitOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Move tab to split right</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={!canSplitMenuTab}
          onClick={() => {
            if (menuTab) moveTabToNewPane(menuTab.id, 'down');
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <HorizontalSplitOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Move tab to split down</ListItemText>
        </MenuItem>
        {menuTab?.profile && menuTab.status === 'closed' ? (
          <>
            <Divider />
            <MenuItem
              onClick={() => {
                reconnect([menuTab.id]);
                setMenu(null);
              }}
            >
              <ListItemIcon>
                <ReplayOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Reconnect</ListItemText>
            </MenuItem>
            {menuTab.profile.kind === 'ssh' ? (
              <>
                <MenuItem
                  onClick={() => {
                    reconnect([menuTab.id], { reattach: 'tmux' });
                    setMenu(null);
                  }}
                >
                  <ListItemIcon>
                    <TerminalIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>Reconnect + tmux</ListItemText>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    reconnect([menuTab.id], { reattach: 'screen' });
                    setMenu(null);
                  }}
                >
                  <ListItemIcon>
                    <TerminalIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>Reconnect + screen</ListItemText>
                </MenuItem>
              </>
            ) : null}
          </>
        ) : null}
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
            <PodcastsOutlinedIcon fontSize="small" color={menuTab && multiExecSelected.has(menuTab.id) ? 'warning' : 'inherit'} />
          </ListItemIcon>
          <ListItemText>
            {menuTab && multiExecSelected.has(menuTab.id) ? 'Remove from multi-execution' : 'Add to multi-execution'}
          </ListItemText>
        </MenuItem>
        <MenuItem
          disabled={
            menuTab?.status !== 'connected' ||
            menuTab.loggingEnabled === undefined
          }
          onClick={() => {
            if (menuTab) {
              terminalHandle(menuTab.id)?.setLogging({
                enabled: !menuTab.loggingEnabled,
              });
            }
            setMenu(null);
          }}
        >
          <ListItemIcon>
            {menuTab?.loggingEnabled ? (
              <StopCircleOutlinedIcon fontSize="small" />
            ) : (
              <PlayCircleOutlineIcon fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText>
            {menuTab?.loggingEnabled
              ? 'Stop session logging'
              : 'Start session logging'}
          </ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            if (menuTab) void requestCloseTabs([menuTab.id]);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <CloseIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Close tab</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={!tabs.some((tab) => tab.id !== menuTab?.id && !tab.pinned)}
          onClick={() => {
            if (menuTab) {
              void requestCloseTabs(
                tabs.filter((tab) => tab.id !== menuTab.id && !tab.pinned).map((tab) => tab.id),
              );
            }
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
