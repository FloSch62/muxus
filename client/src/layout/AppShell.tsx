import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import Box from '@mui/material/Box';
import { alpha } from '@mui/material/styles';
import {
  isDesktopProfile,
  isManagementProfile,
  isTerminalProfile,
} from '@muxus/shared/ws-protocol';
import { paneFocusOpacity, usePrefsStore } from '../state/prefs.js';
import { multiExecPaneIds, useMultiExecStore } from '../state/multi-exec.js';
import {
  useTabsStore,
  tabsInOrder,
  type PaneLeaf,
  type PaneNode,
  type TerminalTab,
} from '../state/tabs.js';
import {
  flattenPaneLayout,
  updateSplitRatio,
  type LayoutRect,
  type SplitNode,
} from '../state/workspace-layout.js';
import { usePaneSurfaceStore } from '../state/pane-surface.js';
import { useUiStore } from '../state/ui.js';
import {
  useWorkspacePersistence,
  type WorkspaceInitialSelection,
} from '../workspace-persistence.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { CommandLineLaunchHandler } from '../components/CommandLineLaunchHandler.js';
import { ActionBar } from '../components/ActionBar.js';
import { StatusBar } from '../components/StatusBar.js';
import { EmptyPane } from '../components/EmptyPane.js';
import { TabStrip } from '../components/TabStrip.js';
import { TerminalView, useDefaultTerminalBackground } from '../components/TerminalView.js';
import { RemoteDesktopView } from '../components/RemoteDesktopView.js';
import { ManagementView } from '../components/ManagementView.js';
import { HostMonitorView } from '../components/HostMonitorView.js';
import { HostsView } from '../components/hosts/HostsView.js';
import { useForwardingRefresh } from '../forwarding-refresh.js';
import { loadRemoteEditorWorkspace } from '../lazy-features.js';
import { useEnvironmentDiscovery } from '../components/environments/useEnvironmentDiscovery.js';
import { layout, sheet } from '../theme.js';
import { Sidebar } from './Sidebar.js';
import { TopBar } from './TopBar.js';

const RemoteEditorWorkspace = lazy(() =>
  loadRemoteEditorWorkspace().then((module) => ({ default: module.RemoteEditorWorkspace })),
);

/** App chrome over a stable, resizable pane canvas. Hidden tabs stay mounted. */
export function AppShell({
  persistWorkspace = true,
  initialWorkspace,
}: {
  persistWorkspace?: boolean;
  initialWorkspace?: WorkspaceInitialSelection;
}) {
  useWorkspacePersistence(persistWorkspace, initialWorkspace);
  useEnvironmentDiscovery();
  useForwardingRefresh();
  const sidebarCollapsed = usePrefsStore((state) => state.sidebarCollapsed);
  const sidebarOnRight = usePrefsStore((state) => state.sidebarPosition === 'right');
  const commandBarAtBottom = usePrefsStore((state) => state.commandBarPosition === 'bottom');
  const tabs = useTabsStore((state) => state.tabs);
  const root = useTabsStore((state) => state.root);
  const activePaneId = useTabsStore((state) => state.activePaneId);
  const zoomedPaneId = useTabsStore((state) => state.zoomedPaneId);
  const focusMode = useUiStore((state) => state.focusMode);
  const sidebarPanelOpen = useUiStore((state) => state.sidebarPanelOpen);
  const setHostEditor = useUiStore((state) => state.setHostEditor);
  const showSidebar = !focusMode && !sidebarCollapsed;
  // The sidebar brings the gap on its own side; the panes keep it on the others.
  const gapLeft = focusMode || (showSidebar && !sidebarOnRight) ? 0 : sheet.gap;
  const gapRight = focusMode || (showSidebar && sidebarOnRight) ? 0 : sheet.gap;
  // With the sidebar's panel closed the panes stand where its card would: a
  // pixel into the rail, so a label carved out of the rail meets their edge.
  const besideRail = showSidebar && !sidebarPanelOpen ? '-1px' : 0;

  return (
    <Box
      data-focus-mode={focusMode ? 'true' : 'false'}
      sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'sidebar' }}
    >
      <CommandLineLaunchHandler />
      <TopBar />
      {focusMode || commandBarAtBottom ? null : <ActionBar position="top" />}
      {/* Positioned, so the sidebar's file browser can spread over the panes. */}
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        {showSidebar && !sidebarOnRight ? <Sidebar /> : null}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            boxSizing: 'border-box',
            // Level with the sidebar's panel at the top and the bottom.
            py: `${focusMode ? 0 : sheet.gap}px`,
            pl: `${gapLeft}px`,
            pr: `${gapRight}px`,
            [sidebarOnRight ? 'mr' : 'ml']: besideRail,
          }}
        >
          <PaneCanvas
            root={root}
            tabs={tabs}
            activePaneId={activePaneId}
            zoomedPaneId={zoomedPaneId}
            hideChrome={focusMode}
            onAddHost={() => setHostEditor({ mode: 'new' })}
          />
        </Box>
        {showSidebar && sidebarOnRight ? <Sidebar /> : null}
      </Box>
      {focusMode || !commandBarAtBottom ? null : <ActionBar position="bottom" />}
      {focusMode ? null : <StatusBar />}
    </Box>
  );
}

/**
 * Panes, tab contents and dividers are siblings in one absolutely positioned
 * layer, each keyed by its own id. Reshaping the tree — splitting, closing a
 * pane, sending a tab to another pane — only moves boxes, so terminals are
 * never unmounted and live sessions survive every layout change.
 */
function PaneCanvas({
  root,
  tabs,
  activePaneId,
  zoomedPaneId,
  hideChrome,
  onAddHost,
}: {
  root: PaneNode;
  tabs: TerminalTab[];
  activePaneId: string;
  zoomedPaneId: string | null;
  hideChrome: boolean;
  onAddHost: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<string, HTMLDivElement>());
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const dividerRefs = useRef(new Map<string, HTMLHRElement>());
  const focusPane = useTabsStore((state) => state.focusPane);
  const resizeSplit = useTabsStore((state) => state.resizeSplit);
  const activateEditor = useTabsStore((state) => state.activateEditor);
  const closeEditor = useTabsStore((state) => state.closeEditor);
  const showTerminal = useTabsStore((state) => state.showTerminal);
  const tabNumberVisibility = usePrefsStore((state) => state.tabNumberVisibility);
  const activePaneBorder = usePrefsStore((state) => state.activePaneBorder);
  const dimInactivePanes = usePrefsStore((state) => state.dimInactivePanes);
  const inactivePaneDimStrength = usePrefsStore((state) => state.inactivePaneDimStrength);
  const multiExecTargetIds = useMultiExecStore((state) => state.selectedIds);
  const { panes, dividers } = useMemo(() => flattenPaneLayout(root), [root]);
  const paneById = useMemo(
    () => new Map(panes.map((entry) => [entry.pane.id, entry.pane])),
    [panes],
  );
  const occupiedPaneIds = useMemo(() => new Set(tabs.map((tab) => tab.paneId)), [tabs]);
  const highlightedPaneIds = useMemo(() => {
    const paneIds = multiExecPaneIds(
      panes.map(({ pane }) => pane),
      multiExecTargetIds,
    );
    paneIds.add(activePaneId);
    return paneIds;
  }, [activePaneId, multiExecTargetIds, panes]);
  const tabNumberById = useMemo(
    () => new Map(tabsInOrder(root, tabs).map((tab, index) => [tab.id, index + 1])),
    [root, tabs],
  );

  /** Position every box from a pane tree — the live one, or a drag preview. */
  const applyLayout = useCallback(
    (node: PaneNode) => {
      const flat = flattenPaneLayout(node);
      const rects = new Map(flat.panes.map((entry) => [entry.pane.id, entry.rect]));
      // What a tab's content keeps clear inside its pane: the sheet's hairline
      // and the tab strip under it. Without chrome a pane is its content, edge
      // to edge.
      const frame: Insets = hideChrome
        ? NO_INSETS
        : { top: 1 + layout.tabStripHeight, right: 1, bottom: 1, left: 1 };
      for (const [paneId, element] of paneRefs.current) {
        const rect = rects.get(paneId);
        if (!rect) continue;
        const zoomed = paneId === zoomedPaneId;
        positionBox(element, rect, zoomed, zoomed || hideChrome ? NO_INSETS : gutterInsets(rect));
      }
      for (const [, element] of tabRefs.current) {
        const paneId = element.dataset.paneId;
        const rect = paneId ? rects.get(paneId) : undefined;
        if (!rect) continue;
        const zoomed = paneId === zoomedPaneId;
        positionBox(
          element,
          rect,
          zoomed,
          zoomed || hideChrome ? frame : addInsets(gutterInsets(rect), frame),
        );
      }
      for (const divider of flat.dividers) {
        const element = dividerRefs.current.get(divider.splitId);
        if (element) positionDivider(element, divider.direction, divider.bounds, divider.ratio);
      }
    },
    [hideChrome, zoomedPaneId],
  );

  useLayoutEffect(() => {
    applyLayout(root);
  }, [applyLayout, root, tabs]);
  const outlineHighlighted = activePaneBorder && panes.length > 1 && !zoomedPaneId;

  return (
    <Box
      ref={containerRef}
      className={`muxus-tab-numbers-${tabNumberVisibility}`}
      sx={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
    >
      {panes.map(({ pane }) => (
        <PaneChrome
          key={pane.id}
          pane={pane}
          tabNumberById={tabNumberById}
          empty={!occupiedPaneIds.has(pane.id)}
          focused={pane.id === activePaneId}
          outlined={outlineHighlighted && highlightedPaneIds.has(pane.id)}
          hideChrome={hideChrome}
          opacity={paneFocusOpacity(
            highlightedPaneIds.has(pane.id),
            dimInactivePanes,
            inactivePaneDimStrength,
          )}
          zoomed={pane.id === zoomedPaneId}
          onAddHost={onAddHost}
          register={(element) => registerBox(paneRefs.current, pane.id, element)}
        />
      ))}
      {tabs.map((tab) => {
        const pane = paneById.get(tab.paneId);
        if (!pane) return null;
        const visible = pane.activeTabId === tab.id;
        const editorShown = !!tab.activeEditorPath && !tab.terminalShown;
        return (
          <Box
            key={tab.id}
            ref={(element: HTMLDivElement | null) => registerBox(tabRefs.current, tab.id, element)}
            data-pane-id={tab.paneId}
            data-pane-focused={pane.id === activePaneId ? 'true' : 'false'}
            data-pane-highlighted={highlightedPaneIds.has(pane.id) ? 'true' : 'false'}
            onPointerDown={() => focusPane(tab.paneId)}
            sx={{
              position: 'absolute',
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
              // Inside the sheet's hairline, cut to its lower corners.
              borderRadius: hideChrome ? 0 : `0 0 ${sheet.radius - 1}px ${sheet.radius - 1}px`,
              display: visible ? 'flex' : 'none',
              opacity: paneFocusOpacity(
                highlightedPaneIds.has(pane.id),
                dimInactivePanes,
                inactivePaneDimStrength,
              ),
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
              {tab.profile && isDesktopProfile(tab.profile) ? (
                <ErrorBoundary label="This remote desktop">
                  <RemoteDesktopView
                    tab={tab}
                    profile={tab.profile}
                    active={visible && pane.id === activePaneId}
                  />
                </ErrorBoundary>
              ) : tab.profile && isManagementProfile(tab.profile) ? (
                <ErrorBoundary label="This management session">
                  <ManagementView
                    tab={tab}
                    profile={tab.profile}
                    active={visible && pane.id === activePaneId}
                  />
                </ErrorBoundary>
              ) : tab.profile ? (
                <ErrorBoundary label="This terminal">
                  <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    {/* Open files keep their strip above the terminal. The slot
                        is stable, so opening one never remounts the terminal. */}
                    {tab.editorPaths.length > 0 && (
                      <Box sx={{ flex: editorShown ? 1 : 'none', minHeight: 0 }}>
                        <Suspense fallback={null}>
                          <RemoteEditorWorkspace
                            tabId={tab.id}
                            sourceKind={tab.profile.kind === 'local' ? 'local' : 'sftp'}
                            connId={tab.connId}
                            paths={tab.editorPaths}
                            activePath={tab.activeEditorPath}
                            active={visible && pane.id === activePaneId && editorShown}
                            terminalShown={!editorShown}
                            onActivate={(path) => activateEditor(tab.id, path)}
                            onClose={(path) => closeEditor(tab.id, path)}
                            onShowTerminal={() => showTerminal(tab.id)}
                          />
                        </Suspense>
                      </Box>
                    )}
                    <Box sx={{ flex: 1, minHeight: 0, display: editorShown ? 'none' : 'block' }}>
                      <TerminalView
                        tab={tab}
                        active={visible && pane.id === activePaneId && !editorShown}
                      />
                    </Box>
                  </Box>
                </ErrorBoundary>
              ) : tab.view === 'monitor' ? (
                <ErrorBoundary label="The host monitor">
                  <HostMonitorView visible={visible} />
                </ErrorBoundary>
              ) : tab.view === 'hosts' ? (
                <ErrorBoundary label="The hosts tab">
                  <HostsView visible={visible} />
                </ErrorBoundary>
              ) : (
                <EmptyPane onAddHost={onAddHost} replaceTabId={tab.id} />
              )}
            </Box>
          </Box>
        );
      })}
      {!zoomedPaneId &&
        dividers.map((divider) => (
          <SplitDivider
            key={divider.splitId}
            direction={divider.direction}
            ratio={divider.ratio}
            bounds={divider.bounds}
            flush={hideChrome}
            containerRef={containerRef}
            register={(element) => registerBox(dividerRefs.current, divider.splitId, element)}
            onPreview={(ratio) => applyLayout(updateSplitRatio(root, divider.splitId, ratio))}
            onCommit={(ratio) => resizeSplit(divider.splitId, ratio)}
          />
        ))}
    </Box>
  );
}

function registerBox<T extends HTMLElement>(
  registry: Map<string, T>,
  id: string,
  element: T | null,
): void {
  if (element) registry.set(id, element);
  else registry.delete(id);
}

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const FULL_RECT: LayoutRect = { x: 0, y: 0, width: 1, height: 1 };
/** Each of two panes gives half the gap between their sheets. */
const HALF_GAP = sheet.gap / 2;
const EDGE_EPSILON = 1e-6;

/** The gap a pane leaves toward its neighbors; none toward the canvas's own edge. */
function gutterInsets(rect: LayoutRect): Insets {
  return {
    top: rect.y > EDGE_EPSILON ? HALF_GAP : 0,
    right: rect.x + rect.width < 1 - EDGE_EPSILON ? HALF_GAP : 0,
    bottom: rect.y + rect.height < 1 - EDGE_EPSILON ? HALF_GAP : 0,
    left: rect.x > EDGE_EPSILON ? HALF_GAP : 0,
  };
}

function addInsets(a: Insets, b: Insets): Insets {
  return {
    top: a.top + b.top,
    right: a.right + b.right,
    bottom: a.bottom + b.bottom,
    left: a.left + b.left,
  };
}

function offsetLength(fraction: number, pixels: number): string {
  const percent = `${fraction * 100}%`;
  return pixels ? `calc(${percent} ${pixels < 0 ? '-' : '+'} ${Math.abs(pixels)}px)` : percent;
}

/** Place a box on the canvas, inset by pixels; a zoomed pane fills the canvas instead. */
function positionBox(
  element: HTMLElement,
  rect: LayoutRect,
  zoomed: boolean,
  insets: Insets,
): void {
  const style = element.style;
  const box = zoomed ? FULL_RECT : rect;
  style.left = offsetLength(box.x, insets.left);
  style.top = offsetLength(box.y, insets.top);
  style.width = offsetLength(box.width, -(insets.left + insets.right));
  style.height = offsetLength(box.height, -(insets.top + insets.bottom));
  style.zIndex = zoomed ? '6' : '';
}

function positionDivider(
  element: HTMLElement,
  direction: SplitNode['direction'],
  bounds: LayoutRect,
  ratio: number,
): void {
  const style = element.style;
  if (direction === 'horizontal') {
    style.left = `${(bounds.x + bounds.width * ratio) * 100}%`;
    style.top = `${bounds.y * 100}%`;
    style.width = `${sheet.gap}px`;
    style.height = `${bounds.height * 100}%`;
    return;
  }
  style.left = `${bounds.x * 100}%`;
  style.top = `${(bounds.y + bounds.height * ratio) * 100}%`;
  style.width = `${bounds.width * 100}%`;
  style.height = `${sheet.gap}px`;
}

function PaneChrome({
  pane,
  tabNumberById,
  empty,
  focused,
  outlined,
  hideChrome,
  opacity,
  zoomed,
  onAddHost,
  register,
}: {
  pane: PaneLeaf;
  tabNumberById: ReadonlyMap<string, number>;
  empty: boolean;
  focused: boolean;
  /** Drawn with the accent outline that marks the panes input goes to. */
  outlined: boolean;
  hideChrome: boolean;
  opacity: number;
  zoomed: boolean;
  onAddHost: () => void;
  register: (element: HTMLDivElement | null) => void;
}) {
  const focusPane = useTabsStore((state) => state.focusPane);
  // Under a terminal the sheet takes the terminal's background, so no other
  // color shows at its rounded corners. The tabs keep the theme's colors.
  const painted = usePaneSurfaceStore((state) =>
    pane.activeTabId ? state.colors[pane.activeTabId] : undefined,
  );
  const terminalInFront = useTabsStore((state) => {
    const tab = pane.activeTabId
      ? state.tabs.find((candidate) => candidate.id === pane.activeTabId)
      : undefined;
    return (
      !!tab?.profile &&
      isTerminalProfile(tab.profile) &&
      tab.editorPaths.length === 0
    );
  });
  // Until the terminal has loaded and said what it paints, the scheme it will
  // most likely use stands in, so the sheet does not change color under it.
  const expected = useDefaultTerminalBackground();
  const surface = terminalInFront ? (painted ?? expected) : undefined;

  return (
    <Box
      ref={register}
      onPointerDown={() => focusPane(pane.id)}
      data-pane-focused={focused ? 'true' : 'false'}
      data-pane-outlined={outlined ? 'true' : undefined}
      sx={(theme) => ({
        position: 'absolute',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        opacity,
        '--pane-surface': surface ?? theme.palette.sidebarSheet,
        '--pane-edge': outlined
          ? alpha(theme.palette.primary.main, 0.85)
          : theme.palette.sidebarEdge,
        // A zoomed pane covers the others, gaps included.
        ...(zoomed ? { bgcolor: 'sidebar' } : {}),
      })}
    >
      <Box
        data-pane-sheet
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          overflow: 'hidden',
          bgcolor: 'var(--pane-surface)',
          transition: 'border-color 120ms',
          ...(hideChrome
            ? {}
            : {
                border: '1px solid var(--pane-edge)',
                borderRadius: `${sheet.radius}px`,
              }),
        }}
      >
        {hideChrome ? null : (
          <TabStrip
            paneId={pane.id}
            tabNumberById={tabNumberById}
            focused={focused}
            zoomed={zoomed}
          />
        )}
        {empty ? (
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <EmptyPane onAddHost={onAddHost} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;

function clampSplitRatio(ratio: number): number {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

interface SplitResizeState {
  pointerId: number;
  pendingRatio: number;
  frame: number;
  bodyCursor: string;
  bodyUserSelect: string;
}

function SplitDivider({
  direction,
  ratio,
  bounds,
  flush,
  containerRef,
  register,
  onPreview,
  onCommit,
}: {
  direction: SplitNode['direction'];
  ratio: number;
  bounds: LayoutRect;
  /** The panes meet with no gap between them, so the divider is the line that parts them. */
  flush: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  register: (element: HTMLHRElement | null) => void;
  onPreview: (ratio: number) => void;
  onCommit: (ratio: number) => void;
}) {
  const resizeRef = useRef<SplitResizeState | undefined>(undefined);

  useEffect(
    () => () => {
      const resize = resizeRef.current;
      if (!resize) return;
      if (resize.frame) cancelAnimationFrame(resize.frame);
      document.body.style.cursor = resize.bodyCursor;
      document.body.style.userSelect = resize.bodyUserSelect;
      resizeRef.current = undefined;
    },
    [],
  );

  /** Pointer position → this split's own ratio, independent of its depth. */
  const ratioAt = (event: ReactPointerEvent<HTMLHRElement>): number | undefined => {
    const container = containerRef.current;
    if (!container) return undefined;
    const rect = container.getBoundingClientRect();
    const fraction =
      direction === 'horizontal'
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height;
    const start = direction === 'horizontal' ? bounds.x : bounds.y;
    const size = direction === 'horizontal' ? bounds.width : bounds.height;
    if (size <= 0) return undefined;
    return clampSplitRatio((fraction - start) / size);
  };

  const update = (event: ReactPointerEvent<HTMLHRElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const next = ratioAt(event);
    if (next === undefined) return;
    resize.pendingRatio = next;
    if (resize.frame) return;
    resize.frame = requestAnimationFrame(() => {
      resize.frame = 0;
      onPreview(resize.pendingRatio);
    });
  };

  const finish = (event: ReactPointerEvent<HTMLHRElement>, commit: boolean) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (resize.frame) cancelAnimationFrame(resize.frame);
    document.body.style.cursor = resize.bodyCursor;
    document.body.style.userSelect = resize.bodyUserSelect;
    resizeRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit) onCommit(resize.pendingRatio);
    else onPreview(ratio);
  };

  return (
    <Box
      component="hr"
      ref={register}
      aria-label="Resize split"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-valuemin={MIN_SPLIT_RATIO * 100}
      aria-valuemax={MAX_SPLIT_RATIO * 100}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onDoubleClick={() => onCommit(0.5)}
      onKeyDown={(event) => {
        const decrease =
          direction === 'horizontal' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
        const increase =
          direction === 'horizontal' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
        if (!decrease && !increase && event.key !== 'Home') return;
        event.preventDefault();
        event.stopPropagation();
        onCommit(event.key === 'Home' ? 0.5 : clampSplitRatio(ratio + (increase ? 0.05 : -0.05)));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeRef.current = {
          pointerId: event.pointerId,
          pendingRatio: ratio,
          frame: 0,
          bodyCursor: document.body.style.cursor,
          bodyUserSelect: document.body.style.userSelect,
        };
        document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
        // Only moving resizes, so a plain click leaves the split, and tiling, as they are.
      }}
      onPointerMove={update}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onLostPointerCapture={(event) => finish(event, false)}
      sx={{
        position: 'absolute',
        border: 0,
        m: 0,
        zIndex: 5,
        touchAction: 'none',
        outline: 'none',
        cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize',
        transform: `translate${direction === 'horizontal' ? 'X' : 'Y'}(-${HALF_GAP}px)`,
        '&::after': {
          content: '""',
          position: 'absolute',
          transition: 'opacity 120ms, background-color 120ms',
          ...(flush
            ? {
                // Panes that touch are parted by a hairline.
                bgcolor: 'sidebarEdge',
                ...(direction === 'horizontal'
                  ? { width: '1px', top: 0, bottom: 0, left: HALF_GAP }
                  : { height: '1px', left: 0, right: 0, top: HALF_GAP }),
              }
            : {
                // The gap between two sheets is the handle; it only shows
                // when reached for.
                borderRadius: '1px',
                bgcolor: 'primary.main',
                opacity: 0,
                ...(direction === 'horizontal'
                  ? { width: 2, top: sheet.radius, bottom: sheet.radius, left: HALF_GAP - 1 }
                  : { height: 2, left: sheet.radius, right: sheet.radius, top: HALF_GAP - 1 }),
              }),
        },
        '&:hover::after, &:active::after, &:focus-visible::after': {
          opacity: 1,
          bgcolor: 'primary.main',
        },
      }}
    />
  );
}
