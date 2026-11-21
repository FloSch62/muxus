import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import Box from '@mui/material/Box';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { ThemeProvider, type Theme } from '@mui/material/styles';
import BrightnessAutoOutlinedIcon from '@mui/icons-material/BrightnessAutoOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import FolderOffOutlinedIcon from '@mui/icons-material/FolderOffOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import type { ForwardInfo } from '@muxus/shared';
import { useQueryClient } from '@tanstack/react-query';
import { connectionsQuery, tunnelsQuery, useForwards } from '../api/queries.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PanelResizeHandle } from '../components/PanelResizeHandle.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
import {
  CARD_INSET,
  CARD_RADIUS,
  CONNECTOR_FILLET,
  RAIL_ITEM_GAP,
  RAIL_ITEM_INSET,
  RAIL_ITEM_INSET_PINNED,
  RAIL_ITEM_SIZE,
  RAIL_PADDING_BOTTOM,
  RAIL_PADDING_TOP,
  RAIL_PINNED_WIDTH,
  RAIL_WIDTH,
  railItemTop,
} from '../components/sidebar/flow-geometry.js';
import { RailItem } from '../components/sidebar/RailItem.js';
import {
  clampEnvironmentsPanelWidth,
  DEFAULT_ENVIRONMENTS_PANEL_WIDTH,
  maxEnvironmentsPanelWidth,
  MIN_ENVIRONMENTS_PANEL_WIDTH,
} from '../environments-panel-width.js';
import { fileBrowserUnavailableReason } from '../file-browser.js';
import {
  loadEnvironmentsPanel,
  loadForwardingPanel,
  loadHostMonitorViewImpl,
  loadSessionHistoryDialog,
  loadSettingsDialog,
  loadSftpPanel,
  loadShortcutsDialog,
} from '../lazy-features.js';
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  maxSidebarWidth,
  MIN_SIDEBAR_WIDTH,
} from '../sidebar-width.js';
import { usePrefsStore, type ThemeMode } from '../state/prefs.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore, type SidebarView } from '../state/ui.js';
import { layout } from '../theme.js';
import { openAppWindow } from '../window-management.js';

const SftpPanel = lazy(() =>
  loadSftpPanel().then((module) => ({ default: module.SftpPanel })),
);
const EnvironmentsPanel = lazy(() =>
  loadEnvironmentsPanel().then((module) => ({ default: module.EnvironmentsPanel })),
);
const ForwardingPanel = lazy(() =>
  loadForwardingPanel().then((module) => ({ default: module.ForwardingPanel })),
);

/**
 * The panes stack their own parts up to 6 (a zoomed pane). The rail sits
 * above all of it, and so does the file browser while it fills the window —
 * just below the rail, whose labels still open over it.
 */
const RAIL_Z_INDEX = 12;
const FULL_PANEL_Z_INDEX = 10;

/** The rail's views, top to bottom. The connector finds its item by this order. */
const VIEW_ORDER: readonly SidebarView[] = ['hosts', 'files', 'environments', 'forwarding'];

const VIEW_META: Record<SidebarView, { label: string; icon: ReactNode; preload?: () => void }> = {
  hosts: { label: 'Hosts', icon: <DnsOutlinedIcon /> },
  files: { label: 'File browser', icon: <FolderOutlinedIcon />, preload: () => void loadSftpPanel() },
  environments: {
    label: 'Containers & VMs',
    icon: <ViewInArOutlinedIcon />,
    preload: () => void loadEnvironmentsPanel(),
  },
  // Preloaded by the rail itself, together with the data the panel lists.
  forwarding: { label: 'Port forwarding', icon: <SwapHorizOutlinedIcon /> },
};

const APPEARANCE_OPTIONS = [
  { mode: 'light', label: 'Light', icon: <LightModeOutlinedIcon fontSize="small" /> },
  { mode: 'os', label: 'System', icon: <BrightnessAutoOutlinedIcon fontSize="small" /> },
  { mode: 'dark', label: 'Dark', icon: <DarkModeOutlinedIcon fontSize="small" /> },
] as const satisfies readonly { mode: ThemeMode; label: string; icon: ReactNode }[];

/**
 * The window sidebar: a rail of icons along the window edge and, beside it,
 * one panel at a time — hosts, the file browser, containers and VMs, or
 * port forwarding. The panel is a card that grows out of its rail icon, so the
 * two read as one shape; clicking the icon again closes it and leaves the rail.
 *
 * The rail and the panel's frame are siblings in the app row rather than
 * nested, so the resize handle's clamp still measures the whole window.
 */
export const Sidebar = memo(function Sidebar() {
  const sidebarWidth = usePrefsStore((state) => state.sidebarWidth);
  const environmentsWidth = usePrefsStore((state) => state.environmentsPanelWidth);
  const onRight = usePrefsStore((state) => state.sidebarPosition === 'right');
  const pinned = usePrefsStore((state) => state.sidebarRailPinned);
  const setPrefs = usePrefsStore((state) => state.set);
  const sidebarView = useUiStore((state) => state.sidebarView);
  const panelOpen = useUiStore((state) => state.sidebarPanelOpen);
  const frameRef = useRef<HTMLDivElement>(null);
  /** The containers view widened to take what a usable workspace leaves. */
  const [environmentsWide, setEnvironmentsWide] = useState(false);
  /** The file browser spread over the panes instead of keeping to the sidebar's width. */
  const [filesFull, setFilesFull] = useState(false);
  const view = sidebarView;
  const side = onRight ? 'right' : 'left';
  const away = onRight ? 'left' : 'right';
  const railWidth = pinned ? RAIL_PINNED_WIDTH : RAIL_WIDTH;
  const wide = view === 'environments' && environmentsWide;
  const full = panelOpen && view === 'files' && filesFull;
  // Filling the window is a look at the files, not a state of the sidebar:
  // going anywhere else ends it.
  useEffect(() => {
    if (!panelOpen || view !== 'files') setFilesFull(false);
  }, [panelOpen, view]);

  // Hosts and files share one width, so switching between them never reflows
  // the terminals. The other two keep the widths they were designed for.
  const width =
    view === 'environments'
      ? wide
        ? `calc(100% - ${560 + railWidth}px)`
        : environmentsWidth
      : view === 'forwarding'
        ? Math.max(sidebarWidth, layout.forwardingPanelWidth)
        : sidebarWidth;

  const frame = (
    <Box
      ref={frameRef}
      data-sidebar-frame
      sx={{
        display: panelOpen ? 'flex' : 'none',
        // Unpositioned while the files fill the window, so that what it holds
        // is laid out against the whole row. The frame itself keeps its place
        // and its width either way: the panes beside it are never resized.
        position: full ? 'static' : 'relative',
        width,
        minWidth: view === 'environments' ? MIN_ENVIRONMENTS_PANEL_WIDTH : undefined,
        maxWidth: wide ? '75%' : view === 'environments' ? 'calc(100% - 560px)' : '45%',
        flexShrink: 0,
        height: '100%',
        boxSizing: 'border-box',
        bgcolor: 'sidebar',
        // The card's edge takes the place of the rail's, a pixel into it.
        [onRight ? 'mr' : 'ml']: '-1px',
        [onRight ? 'borderLeft' : 'borderRight']: 1,
        borderColor: 'divider',
      }}
      onKeyDown={(event) => {
        if (!full || event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        setFilesFull(false);
      }}
    >
      <Box
        data-sidebar-surface
        data-full={full ? 'true' : undefined}
        sx={{
          display: 'flex',
          boxSizing: 'border-box',
          bgcolor: 'sidebar',
          py: `${CARD_INSET}px`,
          [onRight ? 'pl' : 'pr']: `${CARD_INSET}px`,
          ...(full
            ? {
                // Over the panes rather than beside them, from the rail to the
                // far edge of the window.
                position: 'absolute',
                top: 0,
                bottom: 0,
                [side]: railWidth - 1,
                [away]: 0,
                zIndex: FULL_PANEL_Z_INDEX,
                // It grows out of the sidebar it was, rather than appearing.
                animation: `muxus-files-fill-${side} 200ms cubic-bezier(0.2, 0, 0, 1)`,
                '@keyframes muxus-files-fill-left': {
                  from: { clipPath: `inset(0 calc(100% - ${sidebarWidth}px) 0 0)` },
                  to: { clipPath: 'inset(0 0 0 0)' },
                },
                '@keyframes muxus-files-fill-right': {
                  from: { clipPath: `inset(0 0 0 calc(100% - ${sidebarWidth}px))` },
                  to: { clipPath: 'inset(0 0 0 0)' },
                },
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
              }
            : { flex: 1, minWidth: 0 }),
        }}
      >
        <ThemeProvider theme={sheetTheme}>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              border: '1px solid',
              borderColor: 'sidebarEdge',
              borderRadius: `${CARD_RADIUS}px`,
              bgcolor: 'sidebar',
            }}
          >
            <SidebarPanel view="hosts" shown={view === 'hosts'}>
              <SessionSidebar />
            </SidebarPanel>
            <SidebarPanel view="files" shown={view === 'files'}>
              <SidebarFileBrowser
                shown={panelOpen && view === 'files'}
                full={full}
                onFullChange={setFilesFull}
              />
            </SidebarPanel>
            {panelOpen && view === 'environments' ? (
              <SidebarPanel view="environments" shown>
                <ErrorBoundary label="The containers and VMs panel">
                  <Suspense fallback={null}>
                    <EnvironmentsPanel wide={environmentsWide} onWideChange={setEnvironmentsWide} />
                  </Suspense>
                </ErrorBoundary>
              </SidebarPanel>
            ) : null}
            {panelOpen && view === 'forwarding' ? (
              <SidebarPanel view="forwarding" shown>
                <ErrorBoundary label="The forwarding panel">
                  <Suspense fallback={null}>
                    <ForwardingPanel />
                  </Suspense>
                </ErrorBoundary>
              </SidebarPanel>
            ) : null}
          </Box>
        </ThemeProvider>
      </Box>
      {full ? null : view === 'hosts' || view === 'files' ? (
        <PanelResizeHandle
          panelRef={frameRef}
          edge={onRight ? 'left' : 'right'}
          width={sidebarWidth}
          defaultWidth={DEFAULT_SIDEBAR_WIDTH}
          minWidth={MIN_SIDEBAR_WIDTH}
          maxWidth={maxSidebarWidth}
          clampWidth={clampSidebarWidth}
          onWidthChange={(nextSidebarWidth) => setPrefs({ sidebarWidth: nextSidebarWidth })}
          label="Resize sidebar"
        />
      ) : view === 'environments' && !wide ? (
        <PanelResizeHandle
          panelRef={frameRef}
          edge={onRight ? 'left' : 'right'}
          width={environmentsWidth}
          defaultWidth={DEFAULT_ENVIRONMENTS_PANEL_WIDTH}
          minWidth={MIN_ENVIRONMENTS_PANEL_WIDTH}
          maxWidth={maxEnvironmentsPanelWidth}
          clampWidth={clampEnvironmentsPanelWidth}
          onWidthChange={(environmentsPanelWidth) => setPrefs({ environmentsPanelWidth })}
          label="Resize containers and VMs panel"
        />
      ) : null}
    </Box>
  );

  const rail = (
    <SidebarRail
      side={side}
      pinned={pinned}
      view={view}
      panelOpen={panelOpen}
    />
  );
  // The rail keeps the window edge on either side.
  return (
    <>
      {onRight ? null : rail}
      {frame}
      {onRight ? rail : null}
    </>
  );
});

/**
 * Inside the card, "the sidebar's background" is the card's own: everything a
 * panel paints in that color — sticky headers, the ring around a status dot —
 * then matches the sheet it sits on without knowing it moved.
 */
function sheetTheme(outer: Theme): Theme {
  return { ...outer, palette: { ...outer.palette, sidebar: outer.palette.sidebarSheet } };
}

/** A view stays mounted behind the others, so it is as it was left. */
function SidebarPanel({
  view,
  shown,
  children,
}: {
  view: SidebarView;
  shown: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      role="tabpanel"
      id={`sidebar-panel-${view}`}
      aria-labelledby={`sidebar-tab-${view}`}
      sx={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: shown ? 'flex' : 'none',
        flexDirection: 'column',
        // Coming to the front, a view settles in from the rail's side.
        animation: 'muxus-sidebar-view 180ms cubic-bezier(0.2, 0, 0, 1)',
        '@keyframes muxus-sidebar-view': {
          from: { opacity: 0, transform: 'translateX(-6px)' },
          to: { opacity: 1, transform: 'none' },
        },
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
    >
      {children}
    </Box>
  );
}

function SidebarRail({
  side,
  pinned,
  view,
  panelOpen,
}: {
  side: 'left' | 'right';
  pinned: boolean;
  view: SidebarView;
  panelOpen: boolean;
}) {
  const themeMode = usePrefsStore((state) => state.themeMode);
  const setPrefs = usePrefsStore((state) => state.set);
  const toggleSidebarView = useUiStore((state) => state.toggleSidebarView);
  const setSidebarView = useUiStore((state) => state.setSidebarView);
  const setHistoryOpen = useUiStore((state) => state.setHistoryOpen);
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const activeTab = useTabsStore((state) => state.tabs.find((tab) => tab.id === state.activeId));
  const openMonitor = useTabsStore((state) => state.openMonitor);
  const [appearanceMenu, setAppearanceMenu] = useState<HTMLElement | null>(null);
  const tabRefs = useRef(new Map<SidebarView, HTMLButtonElement>());
  const queryClient = useQueryClient();
  const { data: forwardsData } = useForwards();
  const forwards = forwardsData?.forwards ?? [];
  // The badge already follows the forwards; the panel also lists connections
  // and saved tunnels. Asked for on the way to the icon, they are there when
  // it opens.
  const preloadForwarding = () => {
    void loadForwardingPanel();
    void queryClient.prefetchQuery(connectionsQuery);
    void queryClient.prefetchQuery(tunnelsQuery);
  };
  const connectedView = panelOpen ? view : undefined;
  const tabViews = VIEW_ORDER;
  const rovingView = connectedView ?? tabViews[0];
  const appearance =
    APPEARANCE_OPTIONS.find((option) => option.mode === themeMode) ?? APPEARANCE_OPTIONS[1];
  const away = side === 'left' ? 'right' : 'left';

  // Arrow keys move between the views and bring the one they land on to the front.
  const onTabKeyDown = (event: ReactKeyboardEvent, current: SidebarView) => {
    const index = tabViews.indexOf(current);
    const target =
      event.key === 'ArrowDown'
        ? tabViews[(index + 1) % tabViews.length]
        : event.key === 'ArrowUp'
          ? tabViews[(index - 1 + tabViews.length) % tabViews.length]
          : event.key === 'Home'
            ? tabViews[0]
            : event.key === 'End'
              ? tabViews[tabViews.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    setSidebarView(target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    <Box
      component="nav"
      aria-label="Sidebar"
      data-sidebar-rail
      data-pinned={pinned}
      sx={{
        width: pinned ? RAIL_PINNED_WIDTH : RAIL_WIDTH,
        flexShrink: 0,
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
        // Above the panes and everything stacked in them, so a label carved
        // out over a zoomed pane or a split divider is never cut off.
        zIndex: RAIL_Z_INDEX,
        display: 'flex',
        flexDirection: 'column',
        gap: `${RAIL_ITEM_GAP}px`,
        pt: `${RAIL_PADDING_TOP}px`,
        pb: `${RAIL_PADDING_BOTTOM}px`,
        bgcolor: 'sidebar',
        // While the panel is open its card draws this edge, a pixel into the rail.
        backgroundClip: 'padding-box',
        [side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid',
        borderColor: panelOpen ? 'transparent' : 'sidebarEdge',
      }}
    >
      <FlowConnector
        side={side}
        pinned={pinned}
        index={VIEW_ORDER.indexOf(view)}
        visible={panelOpen}
      />
      <Box role="tablist" aria-label="Sidebar views" aria-orientation="vertical" sx={{ display: 'contents' }}>
        {VIEW_ORDER.map((entry) => {
          const meta = VIEW_META[entry];
          return (
            <RailItem
              key={entry}
              role="tab"
              id={`sidebar-tab-${entry}`}
              controls={`sidebar-panel-${entry}`}
              label={entry === 'forwarding' ? forwardingLabel(forwards) : meta.label}
              shortLabel={meta.label}
              icon={meta.icon}
              badge={entry === 'forwarding' ? <ForwardsBadge forwards={forwards} /> : undefined}
              pinned={pinned}
              side={side}
              connected={connectedView === entry}
              tabIndex={rovingView === entry ? 0 : -1}
              buttonRef={(element: HTMLButtonElement | null) => {
                if (element) tabRefs.current.set(entry, element);
                else tabRefs.current.delete(entry);
              }}
              onKeyDown={(event) => onTabKeyDown(event, entry)}
              onIntent={entry === 'forwarding' ? preloadForwarding : meta.preload}
              onClick={() => toggleSidebarView(entry)}
            />
          );
        })}
      </Box>
      <RailItem
        label="Host monitor"
        icon={<MonitorHeartOutlinedIcon />}
        pinned={pinned}
        side={side}
        active={activeTab?.view === 'monitor'}
        onIntent={() => void loadHostMonitorViewImpl()}
        onClick={() => openMonitor()}
      />
      <Box sx={{ flex: 1, minHeight: RAIL_ITEM_GAP }} />
      <RailItem
        label="Session history"
        icon={<HistoryOutlinedIcon />}
        pinned={pinned}
        side={side}
        onIntent={() => void loadSessionHistoryDialog()}
        onClick={() => setHistoryOpen(true)}
      />
      <RailItem
        label={`Appearance: ${appearance.label}`}
        shortLabel="Appearance"
        icon={appearance.icon}
        pinned={pinned}
        side={side}
        hasPopup="menu"
        expanded={appearanceMenu ? true : undefined}
        // Lit while its menu is open, so the two read as one.
        active={!!appearanceMenu}
        onClick={(anchor) => setAppearanceMenu(anchor)}
      />
      <RailItem
        label="Keyboard shortcuts"
        icon={<KeyboardOutlinedIcon />}
        pinned={pinned}
        side={side}
        onIntent={() => void loadShortcutsDialog()}
        onClick={() => setShortcutsOpen(true)}
      />
      <RailItem
        label="Settings"
        icon={<SettingsOutlinedIcon />}
        pinned={pinned}
        side={side}
        onIntent={() => void loadSettingsDialog()}
        onClick={() => setSettingsOpen(true)}
      />
      <RailItem
        label={pinned ? 'Unpin labels' : 'Pin labels'}
        icon={pinned ? <PushPinIcon /> : <PushPinOutlinedIcon />}
        pinned={pinned}
        side={side}
        pressed={pinned}
        onClick={() => setPrefs({ sidebarRailPinned: !pinned })}
      />
      <Menu
        open={!!appearanceMenu}
        anchorEl={appearanceMenu}
        onClose={() => setAppearanceMenu(null)}
        anchorOrigin={{ vertical: 'center', horizontal: away }}
        transformOrigin={{ vertical: 'center', horizontal: side }}
        // Just past the rail's edge, level with the item it belongs to.
        slotProps={{ paper: { sx: { ml: side === 'left' ? '10px' : '-10px' } } }}
      >
        {APPEARANCE_OPTIONS.map((option) => (
          <MenuItem
            key={option.mode}
            selected={option.mode === themeMode}
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
    </Box>
  );
}

/**
 * The tab the open panel grows out of: the active item's row in the card's
 * color, joined to the card by two concave corners. It moves by a transform,
 * so switching views slides it along the rail without laying anything out.
 */
function FlowConnector({
  side,
  pinned,
  index,
  visible,
}: {
  side: 'left' | 'right';
  pinned: boolean;
  index: number;
  visible: boolean;
}) {
  const inset = pinned ? RAIL_ITEM_INSET_PINNED : RAIL_ITEM_INSET;
  const top = railItemTop(Math.max(index, 0)) - RAIL_PADDING_TOP - CONNECTOR_FILLET;
  return (
    <Box
      aria-hidden
      data-sidebar-connector
      sx={{
        position: 'absolute',
        top: RAIL_PADDING_TOP,
        [side]: inset,
        // Half a pixel past the rail's edge, where the card's hairline is centered.
        width: (pinned ? RAIL_PINNED_WIDTH : RAIL_WIDTH) + 1.5 - inset,
        height: RAIL_ITEM_SIZE + 2 * CONNECTOR_FILLET,
        pointerEvents: 'none',
        zIndex: 0,
        color: 'sidebarEdge',
        opacity: visible ? 1 : 0,
        transform: `translateY(${top}px)${side === 'right' ? ' scaleX(-1)' : ''}`,
        transition: 'transform 260ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease',
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
        '& [data-fill]': { fill: (theme) => theme.palette.sidebarSheet },
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          left: 0,
          right: 12,
          top: CONNECTOR_FILLET,
          height: RAIL_ITEM_SIZE,
          boxSizing: 'border-box',
          bgcolor: 'sidebarSheet',
          border: '1px solid currentColor',
          borderRight: 0,
          borderRadius: '9px 0 0 9px',
        }}
      />
      <svg
        width="12"
        height="56"
        viewBox="0 0 12 56"
        fill="none"
        style={{ position: 'absolute', right: 0, top: 0, display: 'block', overflow: 'visible' }}
      >
        <path data-fill d="M0 10.5A10 10 0 0 0 10 .5H12V55.5H10A10 10 0 0 0 0 45.5Z" />
        <path d="M0 10.5A10 10 0 0 0 10 .5M10 55.5A10 10 0 0 0 0 45.5" stroke="currentColor" />
      </svg>
    </Box>
  );
}

function countForwards(forwards: readonly ForwardInfo[], status: ForwardInfo['status']): number {
  return forwards.filter((forward) => forward.status === status).length;
}

/** Tunnels whose connection dropped, or that could not start on their own. */
function interruptedForwards(forwards: readonly ForwardInfo[]): number {
  return countForwards(forwards, 'reconnecting') + countForwards(forwards, 'error');
}

function forwardingLabel(forwards: readonly ForwardInfo[]): string {
  const active = countForwards(forwards, 'active');
  const starting = countForwards(forwards, 'starting');
  const interrupted = interruptedForwards(forwards);
  const summary = [
    active ? `${active} active` : '',
    starting ? `${starting} starting` : '',
    interrupted ? `${interrupted} interrupted` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return summary ? `Port forwarding · ${summary}` : 'Port forwarding';
}

function ForwardsBadge({ forwards }: { forwards: readonly ForwardInfo[] }) {
  if (forwards.length === 0) return null;
  const interrupted = interruptedForwards(forwards) > 0;
  return (
    <Box
      component="span"
      aria-hidden
      sx={(theme) => ({
        position: 'absolute',
        top: 2,
        right: 1,
        minWidth: 14,
        height: 14,
        px: '3px',
        boxSizing: 'border-box',
        borderRadius: '7px',
        bgcolor: interrupted ? 'warning.main' : 'success.main',
        color: theme.palette.getContrastText(
          interrupted ? theme.palette.warning.main : theme.palette.success.main,
        ),
        fontSize: 9,
        fontWeight: 600,
        lineHeight: '14px',
        textAlign: 'center',
        fontVariantNumeric: 'tabular-nums',
      })}
    >
      {forwards.length > 99 ? '99+' : forwards.length}
    </Box>
  );
}

/**
 * The active session's files. Behind another view the browser stays on the
 * session it last showed, so an upload in flight or the folder it was in
 * survives a look at the hosts.
 */
function SidebarFileBrowser({
  shown,
  full,
  onFullChange,
}: {
  shown: boolean;
  /** Spread over the panes instead of keeping to the sidebar's width. */
  full: boolean;
  onFullChange: (full: boolean) => void;
}) {
  const activeId = useTabsStore((state) => state.activeId);
  // Nothing is listed until the view has been opened at least once.
  const [heldId, setHeldId] = useState(shown ? activeId : undefined);
  if (shown && heldId !== activeId) setHeldId(activeId);
  const tabId = shown ? activeId : heldId;
  const tab = useTabsStore((state) => state.tabs.find((candidate) => candidate.id === tabId));
  const updateTab = useTabsStore((state) => state.update);
  const openEditor = useTabsStore((state) => state.openEditor);
  const available = !!tab?.connId && tab.sftpAvailable !== false;
  // A tab without files has nothing to fill the window with, and its
  // placeholder would only hide the tab that is in front.
  useEffect(() => {
    if (full && !available) onFullChange(false);
  }, [full, available, onFullChange]);

  if (heldId === undefined) return null;
  if (!tab?.connId || tab.sftpAvailable === false) {
    return (
      <Stack sx={{ flex: 1, minHeight: 0 }}>
        <Stack direction="row" sx={{ px: 1.25, pt: 1, alignItems: 'center' }}>
          <FolderOpenOutlinedIcon sx={{ mr: 0.75, fontSize: 18, color: 'primary.main' }} />
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            File browser
          </Typography>
        </Stack>
        <Stack spacing={1.5} sx={{ alignItems: 'center', p: 3, pt: 5, textAlign: 'center' }}>
          <FolderOffOutlinedIcon sx={{ fontSize: 36, color: 'text.disabled' }} />
          <Typography variant="body2" color="textSecondary">
            {fileBrowserUnavailableReason(tab)}
          </Typography>
        </Stack>
      </Stack>
    );
  }
  const connId = tab.connId;
  return (
    <ErrorBoundary label="The file browser">
      <Suspense fallback={null}>
        <SftpPanel
          key={connId}
          connId={connId}
          tabId={tab.id}
          inSidebar
          shown={shown}
          hostLabel={tab.title}
          terminalPath={tab.terminalCwd}
          followTerminalFolder={tab.sftpFollowTerminal !== false && !tab.systemOpenSsh}
          followTerminalFolderUnavailable={tab.systemOpenSsh === true}
          onFollowTerminalFolderChange={(sftpFollowTerminal) =>
            updateTab(tab.id, { sftpFollowTerminal })
          }
          full={full}
          onFullChange={onFullChange}
          onOpenFile={(path) => {
            // The file opens in the session's tab, which the files would cover.
            onFullChange(false);
            openEditor(tab.id, path);
          }}
          onOpenInNewWindow={(path) =>
            openAppWindow({ kind: 'sftp', connId, title: tab.title, path })
          }
        />
      </Suspense>
    </ErrorBoundary>
  );
}
