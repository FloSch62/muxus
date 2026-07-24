import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import { usePrefsStore } from '../state/prefs.js';
import {
  useTabsStore,
  type PaneLeaf,
  type PaneNode,
  type TerminalTab,
} from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { useWorkspacePersistence } from '../workspace-persistence.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { EmptyPane } from '../components/EmptyPane.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
import { TabStrip } from '../components/TabStrip.js';
import { TerminalView } from '../components/TerminalView.js';
import {
  loadForwardingPanel,
  loadRemoteEditorWorkspace,
  loadSftpPanel,
} from '../lazy-features.js';
import { TopBar } from './TopBar.js';

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
export function AppShell() {
  useWorkspacePersistence();
  const sidebarCollapsed = usePrefsStore((state) => state.sidebarCollapsed);
  const tabs = useTabsStore((state) => state.tabs);
  const root = useTabsStore((state) => state.root);
  const activePaneId = useTabsStore((state) => state.activePaneId);
  const forwardingOpen = useUiStore((state) => state.forwardingOpen);
  const setHostEditor = useUiStore((state) => state.setHostEditor);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <TopBar />
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {!sidebarCollapsed && <SessionSidebar />}
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <PaneCanvas
            root={root}
            tabs={tabs}
            activePaneId={activePaneId}
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
      <ConfirmCloseDialog />
    </Box>
  );
}

/** Pref-gated confirmation before closing tabs or panes with live sessions. */
function ConfirmCloseDialog() {
  const request = useUiStore((state) => state.confirmClose);
  const setConfirmClose = useUiStore((state) => state.setConfirmClose);
  const tabs = useTabsStore((state) => state.tabs);
  const close = useTabsStore((state) => state.close);
  const closePane = useTabsStore((state) => state.closePane);
  const setPrefs = usePrefsStore((state) => state.set);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  const targets = (request?.tabIds ?? []).map((id) => tabs.find((tab) => tab.id === id)).filter((tab) => tab !== undefined);
  const live = targets.filter((tab) => tab.status === 'connected');
  const label = live.length === 1 ? `“${live[0]!.title}” has a live session` : `${live.length} tabs have live sessions`;

  const dismiss = () => {
    setConfirmClose(null);
    setDontAskAgain(false);
  };

  return (
    <Dialog open={!!request} onClose={dismiss} maxWidth="xs" fullWidth>
      <DialogTitle>
        {request?.paneId
          ? 'Close this pane?'
          : `Close ${targets.length === 1 ? 'this tab' : `${targets.length} tabs`}?`}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          {label} — closing ends it.
        </Typography>
        <FormControlLabel
          sx={{ mt: 1 }}
          control={<Checkbox size="small" checked={dontAskAgain} onChange={(e) => setDontAskAgain(e.target.checked)} />}
          label={<Typography variant="body2">Don’t ask again</Typography>}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={dismiss}>Cancel</Button>
        <Button
          variant="contained"
          color="error"
          onClick={() => {
            if (dontAskAgain) setPrefs({ confirmCloseConnected: false });
            if (request?.paneId) closePane(request.paneId);
            else for (const tab of targets) close(tab.id);
            dismiss();
          }}
        >
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PaneCanvas({
  root,
  tabs,
  activePaneId,
  onAddHost,
}: {
  root: PaneNode;
  tabs: TerminalTab[];
  activePaneId: string;
  onAddHost: () => void;
}) {
  return (
    <Box sx={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <PaneTree
        node={root}
        tabs={tabs}
        activePaneId={activePaneId}
        onAddHost={onAddHost}
      />
    </Box>
  );
}

function PaneTree({
  node,
  tabs,
  activePaneId,
  onAddHost,
}: {
  node: PaneNode;
  tabs: TerminalTab[];
  activePaneId: string;
  onAddHost: () => void;
}) {
  if (node.type === 'pane') {
    return (
      <PaneView
        pane={node}
        tabs={tabs}
        focused={node.id === activePaneId}
        onAddHost={onAddHost}
      />
    );
  }
  return (
    <SplitPane
      node={node}
      tabs={tabs}
      activePaneId={activePaneId}
      onAddHost={onAddHost}
    />
  );
}

function SplitPane({
  node,
  tabs,
  activePaneId,
  onAddHost,
}: {
  node: Extract<PaneNode, { type: 'split' }>;
  tabs: TerminalTab[];
  activePaneId: string;
  onAddHost: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLHRElement>(null);
  const horizontal = node.direction === 'horizontal';
  const ratioPercent = `${node.ratio * 100}%`;
  const remainderPercent = `${(1 - node.ratio) * 100}%`;

  useLayoutEffect(() => {
    applySplitRatio(
      node.direction,
      node.ratio,
      firstRef.current,
      secondRef.current,
      dividerRef.current,
    );
  }, [node.direction, node.ratio]);

  return (
    <Box ref={containerRef} sx={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <Box
        ref={firstRef}
        sx={{
          position: 'absolute',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          ...(horizontal
            ? { left: 0, top: 0, width: ratioPercent, height: '100%' }
            : { left: 0, top: 0, width: '100%', height: ratioPercent }),
        }}
      >
        <PaneTree
          node={node.children[0]}
          tabs={tabs}
          activePaneId={activePaneId}
          onAddHost={onAddHost}
        />
      </Box>
      <Box
        ref={secondRef}
        sx={{
          position: 'absolute',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          ...(horizontal
            ? { left: ratioPercent, top: 0, width: remainderPercent, height: '100%' }
            : { left: 0, top: ratioPercent, width: '100%', height: remainderPercent }),
        }}
      >
        <PaneTree
          node={node.children[1]}
          tabs={tabs}
          activePaneId={activePaneId}
          onAddHost={onAddHost}
        />
      </Box>
      <SplitDivider
        dividerRef={dividerRef}
        splitId={node.id}
        direction={node.direction}
        ratio={node.ratio}
        containerRef={containerRef}
        firstRef={firstRef}
        secondRef={secondRef}
      />
    </Box>
  );
}

function PaneView({
  pane,
  tabs,
  focused,
  onAddHost,
}: {
  pane: PaneLeaf;
  tabs: TerminalTab[];
  focused: boolean;
  onAddHost: () => void;
}) {
  const focusPane = useTabsStore((state) => state.focusPane);
  const openEditor = useTabsStore((state) => state.openEditor);
  const activateEditor = useTabsStore((state) => state.activateEditor);
  const closeEditor = useTabsStore((state) => state.closeEditor);
  const paneTabs = tabs.filter((tab) => tab.paneId === pane.id);
  const activeTab = paneTabs.find((tab) => tab.id === pane.activeTabId);

  return (
    <Box
      onPointerDown={() => focusPane(pane.id)}
      sx={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <TabStrip paneId={pane.id} focused={focused} />
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {paneTabs.map((tab) => {
            const visible = tab.id === pane.activeTabId;
            return (
              <Box key={tab.id} sx={{ height: '100%', display: visible ? 'block' : 'none' }}>
                {tab.profile ? (
                  <ErrorBoundary label="This terminal">
                    <Box sx={{ height: '100%', display: tab.activeEditorPath ? 'none' : 'block' }}>
                      <TerminalView tab={tab} active={visible && focused && !tab.activeEditorPath} />
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
            );
          })}
          {paneTabs.length === 0 && (
            <EmptyPane onAddHost={onAddHost} />
          )}
        </Box>
        {activeTab?.sftpOpen && activeTab.connId && (
          <ErrorBoundary label="The file browser">
            <Suspense fallback={null}>
              <SftpPanel
                key={activeTab.connId}
                connId={activeTab.connId}
                onOpenFile={(path) => openEditor(activeTab.id, path)}
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </Box>
    </Box>
  );
}

const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;

function clampSplitRatio(ratio: number): number {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

function applySplitRatio(
  direction: 'horizontal' | 'vertical',
  ratio: number,
  first: HTMLDivElement | null,
  second: HTMLDivElement | null,
  divider: HTMLHRElement | null,
): void {
  if (!first || !second || !divider) return;
  const position = `${ratio * 100}%`;
  const remainder = `${(1 - ratio) * 100}%`;
  if (direction === 'horizontal') {
    first.style.width = position;
    second.style.left = position;
    second.style.width = remainder;
    divider.style.left = position;
    return;
  }
  first.style.height = position;
  second.style.top = position;
  second.style.height = remainder;
  divider.style.top = position;
}

interface SplitResizeState {
  pointerId: number;
  pendingRatio: number;
  frame: number;
  bodyCursor: string;
  bodyUserSelect: string;
}

const SplitDivider = function SplitDivider({
  splitId,
  direction,
  ratio,
  containerRef,
  firstRef,
  secondRef,
  dividerRef,
}: {
  splitId: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  containerRef: RefObject<HTMLDivElement | null>;
  firstRef: RefObject<HTMLDivElement | null>;
  secondRef: RefObject<HTMLDivElement | null>;
  dividerRef: RefObject<HTMLHRElement | null>;
}) {
  const resizeSplit = useTabsStore((state) => state.resizeSplit);
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

  const apply = (nextRatio: number) =>
    applySplitRatio(
      direction,
      nextRatio,
      firstRef.current,
      secondRef.current,
      dividerRef.current,
    );

  const update = (event: ReactPointerEvent<HTMLHRElement>) => {
    const resize = resizeRef.current;
    const container = containerRef.current;
    if (!resize || resize.pointerId !== event.pointerId || !container) return;
    const rect = container.getBoundingClientRect();
    resize.pendingRatio = clampSplitRatio(
      direction === 'horizontal'
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height,
    );
    if (resize.frame) return;
    resize.frame = requestAnimationFrame(() => {
      resize.frame = 0;
      apply(resize.pendingRatio);
    });
  };

  const position =
    direction === 'horizontal'
      ? {
          left: `${ratio * 100}%`,
          top: 0,
          width: 6,
          height: '100%',
          transform: 'translateX(-3px)',
          cursor: 'col-resize',
        }
      : {
          left: 0,
          top: `${ratio * 100}%`,
          width: '100%',
          height: 6,
          transform: 'translateY(-3px)',
          cursor: 'row-resize',
        };

  return (
    <Box
      component="hr"
      ref={dividerRef}
      aria-label="Resize split"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-valuemin={MIN_SPLIT_RATIO * 100}
      aria-valuemax={MAX_SPLIT_RATIO * 100}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onDoubleClick={() => resizeSplit(splitId, 0.5)}
      onKeyDown={(event) => {
        const decrease =
          direction === 'horizontal' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
        const increase =
          direction === 'horizontal' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
        if (!decrease && !increase && event.key !== 'Home') return;
        event.preventDefault();
        resizeSplit(splitId, event.key === 'Home' ? 0.5 : ratio + (increase ? 0.05 : -0.05));
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
      onPointerUp={(event) => finishSplitResize(event, true)}
      onPointerCancel={(event) => finishSplitResize(event, false)}
      onLostPointerCapture={(event) => finishSplitResize(event, false)}
      sx={{
        position: 'absolute',
        border: 0,
        m: 0,
        zIndex: 5,
        touchAction: 'none',
        outline: 'none',
        '&::after': {
          content: '""',
          position: 'absolute',
          bgcolor: 'divider',
          ...(direction === 'horizontal'
            ? { width: 1, top: 0, bottom: 0, left: '50%' }
            : { height: 1, left: 0, right: 0, top: '50%' }),
        },
        '&:hover::after, &:focus-visible::after': { bgcolor: 'primary.main' },
        ...position,
      }}
    />
  );

  function finishSplitResize(event: ReactPointerEvent<HTMLHRElement>, commit: boolean) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (resize.frame) cancelAnimationFrame(resize.frame);
    document.body.style.cursor = resize.bodyCursor;
    document.body.style.userSelect = resize.bodyUserSelect;
    resizeRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit) {
      apply(resize.pendingRatio);
      resizeSplit(splitId, resize.pendingRatio);
    } else {
      apply(ratio);
    }
  }
};
