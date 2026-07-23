import {
  useMemo,
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
import {
  flattenPaneLayout,
  type LayoutRect,
} from '../state/workspace-layout.js';
import { useUiStore } from '../state/ui.js';
import { useWorkspacePersistence } from '../workspace-persistence.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { EmptyPane } from '../components/EmptyPane.js';
import { ForwardingPanel } from '../components/ForwardingPanel.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
import { SftpPanel } from '../components/SftpPanel.js';
import { TabStrip } from '../components/TabStrip.js';
import { TerminalView } from '../components/TerminalView.js';
import { RemoteEditorWorkspace } from '../components/RemoteEditorWorkspace.js';
import { TopBar } from './TopBar.js';

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
            <ForwardingPanel />
          </ErrorBoundary>
        )}
      </Box>
      <ConfirmCloseDialog />
    </Box>
  );
}

/** Pref-gated confirmation before closing tabs with live sessions. */
function ConfirmCloseDialog() {
  const tabIds = useUiStore((state) => state.confirmCloseTabs);
  const setConfirmCloseTabs = useUiStore((state) => state.setConfirmCloseTabs);
  const tabs = useTabsStore((state) => state.tabs);
  const close = useTabsStore((state) => state.close);
  const setPrefs = usePrefsStore((state) => state.set);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  const targets = (tabIds ?? []).map((id) => tabs.find((tab) => tab.id === id)).filter((tab) => tab !== undefined);
  const live = targets.filter((tab) => tab.status === 'connected');
  const label = live.length === 1 ? `“${live[0]!.title}” has a live session` : `${live.length} tabs have live sessions`;

  const dismiss = () => {
    setConfirmCloseTabs(null);
    setDontAskAgain(false);
  };

  return (
    <Dialog open={!!tabIds} onClose={dismiss} maxWidth="xs" fullWidth>
      <DialogTitle>Close {targets.length === 1 ? 'this tab' : `${targets.length} tabs`}?</DialogTitle>
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
            for (const tab of targets) close(tab.id);
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
  const containerRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => flattenPaneLayout(root), [root]);

  return (
    <Box ref={containerRef} sx={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {layout.panes.map(({ pane, rect }) => (
        <PaneView
          key={pane.id}
          pane={pane}
          rect={rect}
          tabs={tabs}
          focused={pane.id === activePaneId}
          onAddHost={onAddHost}
        />
      ))}
      {layout.dividers.map((divider) => (
        <SplitDivider key={divider.splitId} {...divider} containerRef={containerRef} />
      ))}
    </Box>
  );
}

function PaneView({
  pane,
  rect,
  tabs,
  focused,
  onAddHost,
}: {
  pane: PaneLeaf;
  rect: LayoutRect;
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
        position: 'absolute',
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
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
                        <RemoteEditorWorkspace
                          tabId={tab.id}
                          connId={tab.connId}
                          paths={tab.editorPaths}
                          activePath={tab.activeEditorPath}
                          onActivate={(path) => activateEditor(tab.id, path)}
                          onClose={(path) => closeEditor(tab.id, path)}
                        />
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
            <SftpPanel
              key={activeTab.connId}
              connId={activeTab.connId}
              onOpenFile={(path) => openEditor(activeTab.id, path)}
            />
          </ErrorBoundary>
        )}
      </Box>
    </Box>
  );
}

function SplitDivider({
  splitId,
  direction,
  bounds,
  ratio,
  containerRef,
}: {
  splitId: string;
  direction: 'horizontal' | 'vertical';
  bounds: LayoutRect;
  ratio: number;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const resizeSplit = useTabsStore((state) => state.resizeSplit);
  const dragging = useRef(false);

  const update = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const value =
      direction === 'horizontal'
        ? (event.clientX - rect.left - bounds.x * rect.width) / (bounds.width * rect.width)
        : (event.clientY - rect.top - bounds.y * rect.height) / (bounds.height * rect.height);
    resizeSplit(splitId, value);
  };

  const position =
    direction === 'horizontal'
      ? {
          left: `${(bounds.x + bounds.width * ratio) * 100}%`,
          top: `${bounds.y * 100}%`,
          width: 6,
          height: `${bounds.height * 100}%`,
          transform: 'translateX(-3px)',
          cursor: 'col-resize',
        }
      : {
          left: `${bounds.x * 100}%`,
          top: `${(bounds.y + bounds.height * ratio) * 100}%`,
          width: `${bounds.width * 100}%`,
          height: 6,
          transform: 'translateY(-3px)',
          cursor: 'row-resize',
        };

  return (
    <Box
      component="hr"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
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
        event.preventDefault();
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        update(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) update(event);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
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
}
