import {
  lazy,
  memo,
  Suspense,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import FolderOffOutlinedIcon from '@mui/icons-material/FolderOffOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import VerticalSplitOutlinedIcon from '@mui/icons-material/VerticalSplitOutlined';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PanelResizeHandle } from '../components/PanelResizeHandle.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
import { fileBrowserUnavailableReason, moveFileBrowser } from '../file-browser.js';
import { loadSftpPanel } from '../lazy-features.js';
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  maxSidebarWidth,
  MIN_SIDEBAR_WIDTH,
} from '../sidebar-width.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore, type SidebarView } from '../state/ui.js';
import { openAppWindow } from '../window-management.js';

const SftpPanel = lazy(() =>
  loadSftpPanel().then((module) => ({ default: module.SftpPanel })),
);

const RAIL_WIDTH = 40;

const VIEWS = [
  { view: 'hosts', label: 'Hosts', Icon: DnsOutlinedIcon },
  { view: 'files', label: 'File browser', Icon: FolderOutlinedIcon },
] as const satisfies readonly { view: SidebarView; label: string; Icon: typeof DnsOutlinedIcon }[];

/**
 * The window sidebar. It holds the hosts tree and, with the file browser
 * docked here, the active session's files, switched by a rail of vertical
 * tabs along the window edge. Both views share one width, so switching
 * between them never reflows the terminals.
 */
export const Sidebar = memo(function Sidebar() {
  const sidebarWidth = usePrefsStore((state) => state.sidebarWidth);
  const onRight = usePrefsStore((state) => state.sidebarPosition === 'right');
  const filesDocked = usePrefsStore((state) => state.fileBrowserPosition === 'sidebar');
  const sidebarView = useUiStore((state) => state.sidebarView);
  const setPrefs = usePrefsStore((state) => state.set);
  const panelRef = useRef<HTMLDivElement>(null);
  const view = filesDocked ? sidebarView : 'hosts';

  // The divider and resize grip face the panes on either side of the window.
  const panel = (
    <Box
      ref={panelRef}
      sx={{
        width: sidebarWidth,
        maxWidth: '45%',
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'sidebar',
        [onRight ? 'borderLeft' : 'borderRight']: 1,
        borderColor: 'divider',
        position: 'relative',
      }}
    >
      <PanelResizeHandle
        panelRef={panelRef}
        edge={onRight ? 'left' : 'right'}
        width={sidebarWidth}
        defaultWidth={DEFAULT_SIDEBAR_WIDTH}
        minWidth={MIN_SIDEBAR_WIDTH}
        maxWidth={maxSidebarWidth}
        clampWidth={clampSidebarWidth}
        onWidthChange={(nextSidebarWidth) => setPrefs({ sidebarWidth: nextSidebarWidth })}
        label={filesDocked ? 'Resize sidebar' : 'Resize hosts sidebar'}
      />
      <SidebarPanel view="hosts" shown={view === 'hosts'} tabbed={filesDocked}>
        <SessionSidebar />
      </SidebarPanel>
      {filesDocked ? (
        <SidebarPanel view="files" shown={view === 'files'} tabbed>
          <SidebarFileBrowser shown={view === 'files'} />
        </SidebarPanel>
      ) : null}
    </Box>
  );
  // The rail keeps to the window edge, outside the resizable width. The panel
  // keeps its place among the children, so docking the file browser here
  // never remounts the hosts tree.
  const rail = filesDocked ? <SidebarRail view={view} onRight={onRight} /> : null;
  return (
    <>
      {onRight ? null : rail}
      {panel}
      {onRight ? rail : null}
    </>
  );
});

/** A view stays mounted behind the other tab, so it is as it was left. */
function SidebarPanel({
  view,
  shown,
  tabbed,
  children,
}: {
  view: SidebarView;
  shown: boolean;
  tabbed: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      {...(tabbed
        ? { role: 'tabpanel', id: `sidebar-panel-${view}`, 'aria-labelledby': `sidebar-tab-${view}` }
        : {})}
      sx={{ flex: 1, minHeight: 0, display: shown ? 'flex' : 'none', flexDirection: 'column' }}
    >
      {children}
    </Box>
  );
}

function SidebarRail({ view, onRight }: { view: SidebarView; onRight: boolean }) {
  const setSidebarView = useUiStore((state) => state.setSidebarView);
  const tabRefs = useRef(new Map<SidebarView, HTMLButtonElement>());

  // Arrow keys move between the tabs and open the one they land on.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const index = VIEWS.findIndex((entry) => entry.view === view);
    const target =
      event.key === 'ArrowDown'
        ? VIEWS[(index + 1) % VIEWS.length]
        : event.key === 'ArrowUp'
          ? VIEWS[(index - 1 + VIEWS.length) % VIEWS.length]
          : event.key === 'Home'
            ? VIEWS[0]
            : event.key === 'End'
              ? VIEWS[VIEWS.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    setSidebarView(target.view);
    tabRefs.current.get(target.view)?.focus();
  };

  return (
    <Box
      role="tablist"
      aria-label="Sidebar"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      sx={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.5,
        py: 1.25,
        bgcolor: 'sidebar',
        [onRight ? 'borderLeft' : 'borderRight']: 1,
        borderColor: 'divider',
      }}
    >
      {VIEWS.map(({ view: entry, label, Icon }) => {
        const selected = entry === view;
        return (
          <Tooltip key={entry} title={label} placement={onRight ? 'left' : 'right'}>
            <ButtonBase
              ref={(element: HTMLButtonElement | null) => {
                if (element) tabRefs.current.set(entry, element);
                else tabRefs.current.delete(entry);
              }}
              role="tab"
              id={`sidebar-tab-${entry}`}
              aria-label={label}
              aria-selected={selected}
              aria-controls={`sidebar-panel-${entry}`}
              tabIndex={selected ? 0 : -1}
              onMouseEnter={entry === 'files' ? () => void loadSftpPanel() : undefined}
              onClick={() => setSidebarView(entry)}
              sx={{
                width: 30,
                height: 30,
                borderRadius: 1.5,
                color: selected ? 'text.primary' : 'text.secondary',
                bgcolor: selected ? 'action.selected' : 'transparent',
                '&:hover': {
                  color: 'text.primary',
                  bgcolor: selected ? 'action.selected' : 'action.hover',
                },
                '&.Mui-focusVisible': {
                  outline: 2,
                  outlineColor: 'primary.main',
                  outlineOffset: -2,
                },
              }}
            >
              <Icon sx={{ fontSize: 18 }} />
            </ButtonBase>
          </Tooltip>
        );
      })}
    </Box>
  );
}

/**
 * The active session's files. Behind the hosts tab the browser stays on the
 * session it last showed, so an upload in flight or the folder it was in
 * survives a look at the hosts.
 */
function SidebarFileBrowser({ shown }: { shown: boolean }) {
  const activeId = useTabsStore((state) => state.activeId);
  // Nothing is listed until the tab has been opened at least once.
  const [heldId, setHeldId] = useState(shown ? activeId : undefined);
  if (shown && heldId !== activeId) setHeldId(activeId);
  const tabId = shown ? activeId : heldId;
  const tab = useTabsStore((state) => state.tabs.find((candidate) => candidate.id === tabId));
  const updateTab = useTabsStore((state) => state.update);
  const openEditor = useTabsStore((state) => state.openEditor);

  if (heldId === undefined) return null;
  if (!tab?.connId || tab.sftpAvailable === false) {
    return (
      <Stack sx={{ flex: 1, minHeight: 0 }}>
        <Stack direction="row" sx={{ px: 1.25, pt: 1, alignItems: 'center' }}>
          <FolderOpenOutlinedIcon sx={{ mr: 0.75, fontSize: 18, color: 'primary.main' }} />
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            File browser
          </Typography>
          <Tooltip title="Move beside the terminal">
            <IconButton
              size="small"
              aria-label="Move file browser beside the terminal"
              onClick={() =>
                moveFileBrowser('pane', tab?.profile?.kind === 'ssh' ? tab.id : undefined)
              }
            >
              <VerticalSplitOutlinedIcon sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>
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
          inSidebar
          shown={shown}
          hostLabel={tab.title}
          terminalPath={tab.terminalCwd}
          followTerminalFolder={tab.sftpFollowTerminal !== false}
          onFollowTerminalFolderChange={(sftpFollowTerminal) =>
            updateTab(tab.id, { sftpFollowTerminal })
          }
          onOpenFile={(path) => openEditor(tab.id, path)}
          onMove={() => moveFileBrowser('pane', tab.id)}
          onOpenInNewWindow={(path) =>
            openAppWindow({ kind: 'sftp', connId, title: tab.title, path })
          }
        />
      </Suspense>
    </ErrorBoundary>
  );
}
