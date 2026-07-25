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
import { usePrefsStore } from '../state/prefs.js';
import {
  useTabsStore,
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
import { useUiStore } from '../state/ui.js';
import { useWorkspacePersistence } from '../workspace-persistence.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { ActionBar } from '../components/ActionBar.js';
import { EmptyPane } from '../components/EmptyPane.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
import { TabStrip } from '../components/TabStrip.js';
import { TerminalView } from '../components/TerminalView.js';
import {
  loadForwardingPanel,
  loadRemoteEditorWorkspace,
  loadSftpPanel,
} from '../lazy-features.js';
import { layout } from '../theme.js';
import { TopBar } from './TopBar.js';
import { openAppWindow } from '../window-management.js';

const ForwardingPanel = lazy(() =>
  loadForwardingPanel().then((module) => ({ default: module.ForwardingPanel })),
);
const SftpPanel = lazy(() =>
  loadSftpPanel().then((module) => ({ default: module.SftpPanel })),
);
const RemoteEditorWorkspace = lazy(() =>
  loadRemoteEditorWorkspace().then((module) => ({ default: module.RemoteEditorWorkspace })),
);

/** TopBar over a stable, resizable pane canvas. Hidden tabs stay mounted. */
export function AppShell({ persistWorkspace = true }: { persistWorkspace?: boolean }) {
  useWorkspacePersistence(persistWorkspace);
  const sidebarCollapsed = usePrefsStore((state) => state.sidebarCollapsed);
  const tabs = useTabsStore((state) => state.tabs);
  const root = useTabsStore((state) => state.root);
  const activePaneId = useTabsStore((state) => state.activePaneId);
  const zoomedPaneId = useTabsStore((state) => state.zoomedPaneId);
  const forwardingOpen = useUiStore((state) => state.forwardingOpen);
  const setHostEditor = useUiStore((state) => state.setHostEditor);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <TopBar />
      <ActionBar />
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {!sidebarCollapsed && <SessionSidebar />}
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <PaneCanvas
            root={root}
            tabs={tabs}
            activePaneId={activePaneId}
            zoomedPaneId={zoomedPaneId}
            onAddHost={() => setHostEditor({ mode: 'new' })}
          />
        </Box>
        {forwardingOpen && (
          <ErrorBoundary label="The forwarding panel">
            <Suspense fallback={null}>
              <ForwardingPanel />
            </Suspense>
          </ErrorBoundary>
        )}
      </Box>
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
  onAddHost,
}: {
  root: PaneNode;
  tabs: TerminalTab[];
  activePaneId: string;
  zoomedPaneId: string | null;
  onAddHost: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<string, HTMLDivElement>());
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const dividerRefs = useRef(new Map<string, HTMLHRElement>());
  const focusPane = useTabsStore((state) => state.focusPane);
  const resizeSplit = useTabsStore((state) => state.resizeSplit);
  const openEditor = useTabsStore((state) => state.openEditor);
  const activateEditor = useTabsStore((state) => state.activateEditor);
  const closeEditor = useTabsStore((state) => state.closeEditor);
  const { panes, dividers } = useMemo(() => flattenPaneLayout(root), [root]);

  /** Position every box from a pane tree — the live one, or a drag preview. */
  const applyLayout = useCallback(
    (node: PaneNode) => {
      const flat = flattenPaneLayout(node);
      const rects = new Map(flat.panes.map((entry) => [entry.pane.id, entry.rect]));
      for (const [paneId, element] of paneRefs.current) {
        const rect = rects.get(paneId);
        if (rect) positionBox(element, rect, paneId === zoomedPaneId, 0);
      }
      for (const [, element] of tabRefs.current) {
        const paneId = element.dataset.paneId;
        const rect = paneId ? rects.get(paneId) : undefined;
        if (rect) positionBox(element, rect, paneId === zoomedPaneId, layout.tabStripHeight);
      }
      for (const divider of flat.dividers) {
        const element = dividerRefs.current.get(divider.splitId);
        if (element) positionDivider(element, divider.direction, divider.bounds, divider.ratio);
      }
    },
    [zoomedPaneId],
  );

  useLayoutEffect(() => {
    applyLayout(root);
  }, [applyLayout, root, tabs]);

  return (
    <Box ref={containerRef} sx={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {panes.map(({ pane }) => (
        <PaneChrome
          key={pane.id}
          pane={pane}
          tabs={tabs}
          focused={pane.id === activePaneId}
          zoomed={pane.id === zoomedPaneId}
          onAddHost={onAddHost}
          register={(element) => registerBox(paneRefs.current, pane.id, element)}
        />
      ))}
      {tabs.map((tab) => {
        const pane = panes.find((entry) => entry.pane.id === tab.paneId)?.pane;
        if (!pane) return null;
        const visible = pane.activeTabId === tab.id;
        return (
          <Box
            key={tab.id}
            ref={(element: HTMLDivElement | null) => registerBox(tabRefs.current, tab.id, element)}
            data-pane-id={tab.paneId}
            onPointerDown={() => focusPane(tab.paneId)}
            sx={{
              position: 'absolute',
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
              display: visible ? 'flex' : 'none',
              ...(pane.id === zoomedPaneId ? { bgcolor: 'background.default' } : {}),
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
              {tab.profile ? (
                <ErrorBoundary label="This terminal">
                  <Box sx={{ height: '100%', display: tab.activeEditorPath ? 'none' : 'block' }}>
                    <TerminalView
                      tab={tab}
                      active={visible && pane.id === activePaneId && !tab.activeEditorPath}
                    />
                  </Box>
                  {tab.editorPaths.length > 0 && (
                    <Box sx={{ height: '100%', display: tab.activeEditorPath ? 'block' : 'none' }}>
                      <Suspense fallback={null}>
                        <RemoteEditorWorkspace
                          tabId={tab.id}
                          connId={tab.connId}
                          paths={tab.editorPaths}
                          activePath={tab.activeEditorPath}
                          onActivate={(path) => activateEditor(tab.id, path)}
                          onClose={(path) => closeEditor(tab.id, path)}
                        />
                      </Suspense>
                    </Box>
                  )}
                </ErrorBoundary>
              ) : (
                <EmptyPane onAddHost={onAddHost} replaceTabId={tab.id} />
              )}
            </Box>
            {visible && tab.sftpOpen && tab.connId && (
              <ErrorBoundary label="The file browser">
                <Suspense fallback={null}>
                  <SftpPanel
                    key={tab.connId}
                    connId={tab.connId}
                    onOpenFile={(path) => openEditor(tab.id, path)}
                    onOpenInNewWindow={(path) =>
                      openAppWindow({
                        kind: 'sftp',
                        connId: tab.connId!,
                        title: tab.title,
                        path,
                      })
                    }
                  />
                </Suspense>
              </ErrorBoundary>
            )}
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

/** Place a box on the canvas; a zoomed pane fills it instead. */
function positionBox(
  element: HTMLElement,
  rect: LayoutRect,
  zoomed: boolean,
  topInset: number,
): void {
  const style = element.style;
  if (zoomed) {
    style.left = '0';
    style.width = '100%';
    style.top = topInset ? `${topInset}px` : '0';
    style.height = topInset ? `calc(100% - ${topInset}px)` : '100%';
    style.zIndex = '6';
    return;
  }
  style.left = `${rect.x * 100}%`;
  style.width = `${rect.width * 100}%`;
  style.top = topInset ? `calc(${rect.y * 100}% + ${topInset}px)` : `${rect.y * 100}%`;
  style.height = topInset ? `calc(${rect.height * 100}% - ${topInset}px)` : `${rect.height * 100}%`;
  style.zIndex = '';
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
    style.width = '6px';
    style.height = `${bounds.height * 100}%`;
    return;
  }
  style.left = `${bounds.x * 100}%`;
  style.top = `${(bounds.y + bounds.height * ratio) * 100}%`;
  style.width = `${bounds.width * 100}%`;
  style.height = '6px';
}

function PaneChrome({
  pane,
  tabs,
  focused,
  zoomed,
  onAddHost,
  register,
}: {
  pane: PaneLeaf;
  tabs: TerminalTab[];
  focused: boolean;
  zoomed: boolean;
  onAddHost: () => void;
  register: (element: HTMLDivElement | null) => void;
}) {
  const focusPane = useTabsStore((state) => state.focusPane);
  const empty = !tabs.some((tab) => tab.paneId === pane.id);

  return (
    <Box
      ref={register}
      onPointerDown={() => focusPane(pane.id)}
      sx={{
        position: 'absolute',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        ...(zoomed ? { bgcolor: 'background.default' } : {}),
      }}
    >
      <TabStrip paneId={pane.id} focused={focused} zoomed={zoomed} />
      {empty && (
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <EmptyPane onAddHost={onAddHost} />
        </Box>
      )}
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
  containerRef,
  register,
  onPreview,
  onCommit,
}: {
  direction: SplitNode['direction'];
  ratio: number;
  bounds: LayoutRect;
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
        update(event);
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
        transform: direction === 'horizontal' ? 'translateX(-3px)' : 'translateY(-3px)',
        '&::after': {
          content: '""',
          position: 'absolute',
          bgcolor: 'divider',
          ...(direction === 'horizontal'
            ? { width: 1, top: 0, bottom: 0, left: '50%' }
            : { height: 1, left: 0, right: 0, top: '50%' }),
        },
        '&:hover::after, &:focus-visible::after': { bgcolor: 'primary.main' },
      }}
    />
  );
}
