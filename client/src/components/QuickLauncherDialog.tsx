import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import SearchIcon from '@mui/icons-material/Search';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import StopOutlinedIcon from '@mui/icons-material/StopOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import WorkspacesOutlinedIcon from '@mui/icons-material/WorkspacesOutlined';
import type {
  ForwardInfo,
  SavedHostProfile,
  SessionLogSummary,
  SessionProfile,
  SshHostEntry,
  TunnelRecord,
  WorkspaceSummary,
} from '@muxus/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useForwards, useSavedHostProfiles, useSessionHistory, useSshConfig, useTunnels } from '../api/queries.js';
import { startTunnel, stopForward } from '../api/tunnels.js';
import { commandButtonInput } from '../command-buttons.js';
import { confirmDiscardRemoteEditors } from '../editor/remote-editor-registry.js';
import {
  managedHostAddress,
  managedHostDisplayName,
  type ManagedHost,
} from '../managed-hosts.js';
import type { KeybindingOverrides } from '../keymap/bindings.js';
import {
  COMMAND_CATEGORY_LABELS,
  KEY_COMMANDS,
  type KeyCommand,
} from '../keymap/commands.js';
import { chordLabels } from '../keymap/hints.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import {
  selectQuickLauncherItems,
  type QuickLauncherItem,
} from '../quick-launcher.js';
import {
  connectManagedHost,
  connectTarget,
  isQuickConnectTarget,
  openLocalTerminal,
} from '../session-actions.js';
import type { CommandButton } from '../state/prefs.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore, type TabStatus } from '../state/tabs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { useUiStore } from '../state/ui.js';
import { useWorkspacesStore } from '../state/workspaces.js';
import { terminalHandle } from '../terminal/terminal-registry.js';
import { formatTimestamp } from '../time-format.js';
import { openWorkspace } from '../workspace-persistence.js';
import { AuthPromptDialog, type AuthPromptRequest } from './AuthPromptDialog.js';
import { HostKeyDialog, type HostKeyRequest } from './HostKeyDialog.js';

type ResultBase = Omit<QuickLauncherItem, 'kind'> & {
  disabledReason?: string;
};

type LauncherResult = ResultBase &
  (
    | { kind: 'tab'; tabId: string; reconnect: boolean }
    | { kind: 'editor'; tabId: string; path: string }
    | { kind: 'host'; host: ManagedHost; protocol: 'ssh' | 'telnet' | 'serial' }
    | { kind: 'quick-connect'; target: string }
    | { kind: 'workspace'; workspace: WorkspaceSummary }
    | { kind: 'command'; command: CommandButton }
    | { kind: 'tunnel'; tunnel: TunnelRecord; running?: ForwardInfo }
    | { kind: 'history'; session: SessionLogSummary; historyQuery: string }
    | { kind: 'action'; action: LauncherAction }
    | { kind: 'keymap'; command: KeyCommand; chord?: string }
  );

type LauncherAction =
  | 'new-local'
  | 'new-host'
  | 'settings'
  | 'workspaces'
  | 'history'
  | 'commands'
  | 'tunnels'
  | 'sftp'
  | 'find-terminal';

const EMPTY_SSH_HOSTS: SshHostEntry[] = [];
const EMPTY_SAVED_HOSTS: SavedHostProfile[] = [];
const EMPTY_TUNNELS: TunnelRecord[] = [];
const EMPTY_FORWARDS: ForwardInfo[] = [];
const EMPTY_HISTORY: SessionLogSummary[] = [];
const RESULT_LIMIT = 40;

export function QuickLauncherDialog() {
  const queryClient = useQueryClient();
  const setOpen = useUiStore((state) => state.setQuickLauncherOpen);
  const tabs = useTabsStore((state) => state.tabs);
  const activeId = useTabsStore((state) => state.activeId);
  const commands = usePrefsStore((state) => state.commandButtons);
  const keybindings = usePrefsStore((state) => state.keybindings);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspacesStore((state) => state.activeId);
  const workspaceBusy = useWorkspacesStore((state) => state.busy);
  const { data: sshData, isLoading: sshLoading } = useSshConfig();
  const { data: savedData, isLoading: savedLoading } = useSavedHostProfiles();
  const { data: tunnelData, isLoading: tunnelsLoading } = useTunnels();
  const { data: forwardData } = useForwards();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const debouncedHistoryQuery = useDebouncedValue(deferredQuery.trim(), 250);
  const historyEnabled = debouncedHistoryQuery.length >= 2;
  const historyResult = useSessionHistory(
    debouncedHistoryQuery,
    undefined,
    historyEnabled,
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingWorkspace, setPendingWorkspace] = useState<WorkspaceSummary>();
  const [busyResultId, setBusyResultId] = useState<string>();
  const [dialAuth, setDialAuth] = useState<{
    request: AuthPromptRequest;
    resolve: (answers: string[] | null) => void;
  } | null>(null);
  const [dialHostKey, setDialHostKey] = useState<{
    request: HostKeyRequest;
    resolve: (accept: boolean) => void;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef(new Map<string, HTMLDivElement>());

  const sshHosts = sshData?.hosts ?? EMPTY_SSH_HOSTS;
  const savedHosts = savedData?.profiles ?? EMPTY_SAVED_HOSTS;
  const tunnels = tunnelData?.tunnels ?? EMPTY_TUNNELS;
  const forwards = forwardData?.forwards ?? EMPTY_FORWARDS;
  const history = historyResult.data?.sessions ?? EMPTY_HISTORY;
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activeConnected = activeTab?.profile && activeTab.status === 'connected';
  const activeSsh = activeConnected && activeTab.profile.kind === 'ssh' && !!activeTab.connId;
  const liveCount = tabs.filter(
    (tab) =>
      tab.profile &&
      (tab.status === 'connected' || tab.status === 'connecting'),
  ).length;

  // The catalog is the expensive half and does not depend on the query, so it
  // is built once per data change instead of on every keystroke. Only the
  // history and quick-connect entries follow what is typed.
  const catalogResults = useMemo(
    () =>
      buildCatalogResults({
        tabs,
        activeId,
        sshHosts,
        savedHosts,
        workspaces,
        activeWorkspaceId,
        commands,
        tunnels,
        forwards,
        activeConnected: !!activeConnected,
      }),
    [
      activeConnected,
      activeId,
      activeWorkspaceId,
      commands,
      forwards,
      savedHosts,
      sshHosts,
      tabs,
      tunnels,
      workspaces,
    ],
  );
  const queryResults = useMemo(
    () =>
      buildQueryResults({
        sshHosts,
        savedHosts,
        history,
        historyQuery: debouncedHistoryQuery,
        directTarget: deferredQuery,
      }),
    [debouncedHistoryQuery, deferredQuery, history, savedHosts, sshHosts],
  );
  const actionResults = useMemo(
    () =>
      buildActionResults({
        activeConnected: !!activeConnected,
        activeSsh: !!activeSsh,
        keybindings,
      }),
    [activeConnected, activeSsh, keybindings],
  );
  const allResults = useMemo(
    () => [...catalogResults, ...queryResults, ...actionResults],
    [actionResults, catalogResults, queryResults],
  );
  const results = useMemo(
    () =>
      selectQuickLauncherItems(
        allResults,
        deferredQuery,
        RESULT_LIMIT,
      ),
    [allResults, deferredQuery],
  );
  const selected = results[selectedIndex];
  const queryStale = query !== deferredQuery;
  const loading =
    sshLoading ||
    savedLoading ||
    tunnelsLoading ||
    (historyEnabled && historyResult.isFetching);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [deferredQuery]);

  useEffect(() => {
    if (selectedIndex < results.length) return;
    setSelectedIndex(Math.max(0, results.length - 1));
  }, [results.length, selectedIndex]);

  useEffect(() => {
    if (!selected) return;
    resultRefs.current.get(selected.id)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const close = () => {
    dialAuth?.resolve(null);
    dialHostKey?.resolve(false);
    setDialAuth(null);
    setDialHostKey(null);
    setOpen(false);
  };

  const refreshForwarding = () => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['forwards'] }),
      queryClient.invalidateQueries({ queryKey: ['connections'] }),
      queryClient.invalidateQueries({ queryKey: ['tunnels'] }),
    ]);
  };

  const performWorkspaceOpen = async (workspace: WorkspaceSummary) => {
    if (!(await confirmDiscardRemoteEditors(tabs.map((tab) => tab.id)))) return;
    setBusyResultId(`workspace:${workspace.id}`);
    try {
      const opened = await openWorkspace(workspace.id);
      showToast('success', `Opened workspace “${opened.name}”.`);
      close();
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBusyResultId(undefined);
      setPendingWorkspace(undefined);
    }
  };

  const toggleTunnel = async (
    tunnel: TunnelRecord,
    running: ForwardInfo | undefined,
  ) => {
    setBusyResultId(`tunnel:${tunnel.id}`);
    try {
      if (running) {
        await stopForward(running.id);
        showToast('success', `Stopped tunnel “${tunnel.name ?? tunnel.target}”.`);
      } else {
        await startTunnel(tunnel, {
          onStatus: () => undefined,
          onAuthPrompt: (request) =>
            new Promise((resolve) => setDialAuth({ request, resolve })),
          onHostKey: (request) =>
            new Promise((resolve) => setDialHostKey({ request, resolve })),
        });
        showToast('success', `Started tunnel “${tunnel.name ?? tunnel.target}”.`);
      }
      refreshForwarding();
      close();
    } catch (error) {
      showErrorToast(error);
      refreshForwarding();
    } finally {
      setBusyResultId(undefined);
    }
  };

  const runAction = (action: LauncherAction) => {
    const ui = useUiStore.getState();
    const tabState = useTabsStore.getState();
    close();
    switch (action) {
      case 'new-local':
        openLocalTerminal();
        break;
      case 'new-host':
        ui.setHostEditor({ mode: 'new' });
        break;
      case 'settings':
        ui.setSettingsOpen(true);
        break;
      case 'workspaces':
        ui.setWorkspacesOpen(true);
        break;
      case 'history':
        ui.setHistoryOpen(true);
        break;
      case 'commands':
        ui.setCommandButtonsOpen(true);
        break;
      case 'tunnels':
        ui.setForwardingOpen(true);
        break;
      case 'sftp': {
        const tab = tabState.tabs.find((candidate) => candidate.id === tabState.activeId);
        if (tab?.profile && tab.profile.kind === 'ssh' && tab.connId) {
          tabState.update(tab.id, { sftpOpen: !tab.sftpOpen });
        }
        break;
      }
      case 'find-terminal':
        tabState.requestSearch();
        break;
    }
  };

  const execute = (result: LauncherResult | undefined) => {
    if (
      !result ||
      result.disabledReason ||
      busyResultId ||
      workspaceBusy ||
      queryStale
    ) {
      return;
    }
    switch (result.kind) {
      case 'tab':
        close();
        useTabsStore.getState().activate(result.tabId);
        if (result.reconnect) useTabsStore.getState().reconnect([result.tabId]);
        break;
      case 'editor':
        close();
        useTabsStore.getState().activate(result.tabId);
        useTabsStore.getState().activateEditor(result.tabId, result.path);
        break;
      case 'host':
        close();
        connectManagedHost(result.host);
        break;
      case 'quick-connect':
        close();
        connectTarget(result.target);
        break;
      case 'workspace':
        if (result.workspace.id === activeWorkspaceId) {
          close();
        } else if (liveCount > 0) {
          setPendingWorkspace(result.workspace);
        } else {
          void performWorkspaceOpen(result.workspace);
        }
        break;
      case 'command': {
        const handle = terminalHandle(activeId);
        const sent = handle?.sendInput(commandButtonInput(result.command)) ?? false;
        if (sent) close();
        else showToast('warning', 'The active terminal is not connected.');
        break;
      }
      case 'tunnel':
        void toggleTunnel(result.tunnel, result.running);
        break;
      case 'history':
        close();
        useUiStore
          .getState()
          .openHistory(result.historyQuery, result.session.id);
        break;
      case 'action':
        runAction(result.action);
        break;
      case 'keymap':
        close();
        result.command.run();
        break;
    }
  };

  const resultDisabled = (result: LauncherResult) =>
    !!result.disabledReason || !!busyResultId || workspaceBusy || queryStale;

  const focusResult = (index: number) => {
    const result = results[index];
    if (!result || resultDisabled(result)) return;
    setSelectedIndex(index);
    resultRefs.current.get(result.id)?.focus({ preventScroll: true });
  };

  const focusResultFromSearch = () => {
    if (selected && !resultDisabled(selected)) {
      focusResult(selectedIndex);
      return;
    }
    const firstEnabled = results.findIndex((result) => !resultDisabled(result));
    if (firstEnabled >= 0) focusResult(firstEnabled);
  };

  const focusAdjacentResult = (index: number, direction: -1 | 1) => {
    for (
      let candidate = index + direction;
      candidate >= 0 && candidate < results.length;
      candidate += direction
    ) {
      const result = results[candidate];
      if (result && !resultDisabled(result)) {
        focusResult(candidate);
        return;
      }
    }
    if (direction === -1) {
      inputRef.current?.focus({ preventScroll: true });
    }
  };

  return (
    <>
      <Dialog
        open
        onClose={() => {
          if (!busyResultId && !workspaceBusy) close();
        }}
        fullWidth
        maxWidth="sm"
        aria-labelledby="quick-launcher-label"
        slotProps={{
          transition: {
            onEntered: () => {
              const activeElement = document.activeElement;
              const resultOwnsFocus = [...resultRefs.current.values()].some(
                (element) => element === activeElement,
              );
              if (activeElement !== inputRef.current && !resultOwnsFocus) {
                inputRef.current?.focus({ preventScroll: true });
              }
            },
          },
          paper: {
            sx: {
              position: 'absolute',
              top: { xs: 16, sm: '10vh' },
              m: 0,
              maxHeight: { xs: 'calc(100% - 32px)', sm: 'min(720px, 80vh)' },
              overflow: 'hidden',
            },
          },
        }}
      >
        <TextField
          inputRef={inputRef}
          fullWidth
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              focusResultFromSearch();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (pendingWorkspace) void performWorkspaceOpen(pendingWorkspace);
              else execute(selected);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              if (pendingWorkspace) setPendingWorkspace(undefined);
              else if (!busyResultId && !workspaceBusy) close();
            }
          }}
          placeholder="Search hosts, tabs, workspaces, commands, tunnels, history…"
          variant="standard"
          slotProps={{
            htmlInput: {
              id: 'quick-launcher-label',
              'aria-label': 'Quick launcher search',
              'aria-activedescendant': selected
                ? `quick-launcher-result-${selected.id}`
                : undefined,
            },
            input: {
              disableUnderline: true,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon color="primary" />
                </InputAdornment>
              ),
              endAdornment: loading ? (
                <InputAdornment position="end">
                  <CircularProgress size={18} />
                </InputAdornment>
              ) : (
                <InputAdornment position="end">
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${HOTKEY_MOD_LABEL}K`}
                    sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10 }}
                  />
                </InputAdornment>
              ),
              sx: { px: 2, py: 1.4, fontSize: 17 },
            },
          }}
        />
        {loading ? <LinearProgress sx={{ height: 2 }} /> : <Divider />}

        {pendingWorkspace ? (
          <Alert
            severity="warning"
            sx={{ mx: 1.5, mt: 1.25 }}
            action={
              <Stack direction="row" spacing={0.5}>
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => setPendingWorkspace(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  color="warning"
                  variant="contained"
                  size="small"
                  disabled={!!busyResultId || workspaceBusy}
                  onClick={() => void performWorkspaceOpen(pendingWorkspace)}
                >
                  Open
                </Button>
              </Stack>
            }
          >
            Open “{pendingWorkspace.name}”? This ends {liveCount} live or
            connecting session{liveCount === 1 ? '' : 's'}.
          </Alert>
        ) : null}

        <DialogContent sx={{ p: 0, minHeight: 180, overflow: 'hidden' }}>
          <List
            id="quick-launcher-results"
            aria-label="Quick launcher results"
            dense
            disablePadding
            sx={{
              maxHeight: pendingWorkspace
                ? 'calc(min(720px, 80vh) - 190px)'
                : 'calc(min(720px, 80vh) - 110px)',
              overflowY: 'auto',
              py: 0.75,
              opacity: queryStale ? 0.72 : 1,
              transition: 'opacity 100ms ease',
            }}
          >
            {results.map((result, index) => {
              const disabled = resultDisabled(result);
              return (
                <ListItemButton
                  key={result.id}
                  id={`quick-launcher-result-${result.id}`}
                  ref={(element) => {
                    if (element) resultRefs.current.set(result.id, element);
                    else resultRefs.current.delete(result.id);
                  }}
                  aria-current={index === selectedIndex}
                  selected={index === selectedIndex}
                  disabled={disabled}
                  tabIndex={!disabled && index === selectedIndex ? 0 : -1}
                  onFocus={() => setSelectedIndex(index)}
                  onMouseMove={() => setSelectedIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      focusAdjacentResult(index, 1);
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      focusAdjacentResult(index, -1);
                    } else if (event.key === 'Home') {
                      event.preventDefault();
                      const firstEnabled = results.findIndex(
                        (candidate) => !resultDisabled(candidate),
                      );
                      if (firstEnabled >= 0) focusResult(firstEnabled);
                    } else if (event.key === 'End') {
                      event.preventDefault();
                      const lastEnabled = results.findLastIndex(
                        (candidate) => !resultDisabled(candidate),
                      );
                      if (lastEnabled >= 0) focusResult(lastEnabled);
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      execute(result);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      if (pendingWorkspace) setPendingWorkspace(undefined);
                      else if (!busyResultId && !workspaceBusy) close();
                    }
                  }}
                  onClick={() => execute(result)}
                  sx={{ mx: 0.75, borderRadius: 1, py: 0.7 }}
                >
                  <ListItemIcon sx={{ minWidth: 38 }}>
                    <ResultIcon result={result} />
                  </ListItemIcon>
                  <ListItemText
                    primary={result.label}
                    secondary={result.disabledReason ?? result.detail}
                    slotProps={{
                      primary: { noWrap: true, sx: { fontWeight: 600 } },
                      secondary: { noWrap: true },
                    }}
                  />
                  <ResultKindLabel result={result} busy={busyResultId === result.id} />
                </ListItemButton>
              );
            })}
            {results.length === 0 && !loading ? (
              <Stack sx={{ py: 5, px: 3, alignItems: 'center', textAlign: 'center' }}>
                <SearchIcon sx={{ color: 'text.disabled', fontSize: 34, mb: 1 }} />
                <Typography variant="body2" color="text.secondary">
                  No launcher results match “{deferredQuery.trim()}”.
                </Typography>
              </Stack>
            ) : null}
          </List>
        </DialogContent>
        <Divider />
        <Stack
          direction="row"
          spacing={2}
          sx={{ px: 2, py: 0.8, alignItems: 'center', color: 'text.secondary' }}
        >
          <KeyHint keys="↑↓" label="navigate" />
          <KeyHint keys="↵" label="open" />
          <KeyHint keys="esc" label="close" />
          <Typography variant="caption" sx={{ ml: 'auto' }}>
            {results.length}
            {results.length === RESULT_LIMIT ? '+' : ''} result
            {results.length === 1 ? '' : 's'}
          </Typography>
        </Stack>
      </Dialog>

      <AuthPromptDialog
        request={dialAuth?.request ?? null}
        onSubmit={(answers) => {
          const pending = dialAuth;
          setDialAuth(null);
          pending?.resolve(answers);
        }}
      />
      <HostKeyDialog
        request={dialHostKey?.request ?? null}
        onAnswer={(accept) => {
          const pending = dialHostKey;
          setDialHostKey(null);
          pending?.resolve(accept);
        }}
      />
    </>
  );
}

/** Everything the launcher can offer that does not depend on the query. */
function buildCatalogResults({
  tabs,
  activeId,
  sshHosts,
  savedHosts,
  workspaces,
  activeWorkspaceId,
  commands,
  tunnels,
  forwards,
  activeConnected,
}: {
  tabs: ReturnType<typeof useTabsStore.getState>['tabs'];
  activeId: string | null;
  sshHosts: readonly SshHostEntry[];
  savedHosts: readonly SavedHostProfile[];
  workspaces: readonly WorkspaceSummary[];
  activeWorkspaceId?: string;
  commands: readonly CommandButton[];
  tunnels: readonly TunnelRecord[];
  forwards: readonly ForwardInfo[];
  activeConnected: boolean;
}): LauncherResult[] {
  const results: LauncherResult[] = [];

  for (const tab of tabs) {
    if (!tab.profile) continue;
    const reconnect = tab.status === 'closed';
    results.push({
      id: `tab:${tab.id}`,
      kind: 'tab',
      tabId: tab.id,
      reconnect,
      label: tab.title,
      detail: `${tabStatusLabel(tab.status)} · ${profileSummary(tab.profile)}`,
      keywords: [tab.profile.kind, ...tab.editorPaths],
      priority:
        (tab.id === activeId ? 500 : 0) +
        (tab.status === 'connected' ? 350 : tab.status === 'connecting' ? 250 : 120),
      showWhenEmpty: tab.id === activeId || tab.status !== 'closed',
    });
    for (const path of tab.editorPaths) {
      results.push({
        id: `editor:${tab.id}:${path}`,
        kind: 'editor',
        tabId: tab.id,
        path,
        label: basename(path),
        detail: `${tab.title} · ${path}`,
        keywords: ['editor', 'remote file', path],
        priority: tab.id === activeId ? 420 : 300,
        showWhenEmpty: path === tab.activeEditorPath,
      });
    }
  }

  for (const entry of sshHosts) {
    const host: ManagedHost = { kind: 'ssh', entry };
    const metadata = entry.metadata;
    results.push({
      id: `host:ssh:${entry.alias}`,
      kind: 'host',
      host,
      protocol: 'ssh',
      label: managedHostDisplayName(host),
      detail: `${metadata?.group ? `${metadata.group} · ` : ''}${managedHostAddress(host)}`,
      keywords: [
        'ssh',
        ...entry.aliases,
        entry.description ?? '',
        entry.file,
        entry.resolved.hostname,
        entry.resolved.user ?? '',
      ],
      priority:
        (metadata?.favorite ? 260 : 0) +
        Math.min(metadata?.connectCount ?? 0, 80) +
        (metadata?.lastConnectedAt ? 60 : 0),
      showWhenEmpty:
        !!metadata?.favorite || (metadata?.connectCount ?? 0) > 0,
    });
  }

  for (const entry of savedHosts) {
    const host: ManagedHost = { kind: 'profile', entry };
    results.push({
      id: `host:profile:${entry.id}`,
      kind: 'host',
      host,
      protocol: entry.kind,
      label: managedHostDisplayName(host),
      detail: `${entry.metadata.group ? `${entry.metadata.group} · ` : ''}${managedHostAddress(host)}`,
      keywords: [entry.kind, entry.name, managedHostAddress(host)],
      priority:
        (entry.metadata.favorite ? 260 : 0) +
        Math.min(entry.metadata.connectCount, 80) +
        (entry.metadata.lastConnectedAt ? 60 : 0),
      showWhenEmpty:
        entry.metadata.favorite || entry.metadata.connectCount > 0,
    });
  }

  for (const [index, workspace] of workspaces.entries()) {
    results.push({
      id: `workspace:${workspace.id}`,
      kind: 'workspace',
      workspace,
      label: workspace.name,
      detail:
        workspace.id === activeWorkspaceId
          ? 'Current workspace'
          : `Workspace · ${formatTimestamp(workspace.lastOpenedAt ?? workspace.updatedAt)}`,
      keywords: ['workspace', workspace.isStartup ? 'startup' : ''],
      priority: workspace.id === activeWorkspaceId ? 360 : 150,
      showWhenEmpty: workspace.id === activeWorkspaceId || index < 5,
    });
  }

  for (const [index, command] of commands.entries()) {
    results.push({
      id: `command:${command.id}`,
      kind: 'command',
      command,
      label: command.label.trim() || command.command.trim() || 'Command',
      detail: command.sendEnter
        ? `Run · ${oneLine(command.command)}`
        : `Insert · ${oneLine(command.command)}`,
      keywords: ['command', 'saved command', command.command],
      priority: 130,
      showWhenEmpty: activeConnected && index < 5,
      disabledReason: activeConnected ? undefined : 'Connect a terminal to use this command',
    });
  }

  const runningByTunnel = new Map(
    forwards
      .filter((forward) => forward.tunnelId)
      .map((forward) => [forward.tunnelId!, forward]),
  );
  for (const tunnel of tunnels) {
    const running = runningByTunnel.get(tunnel.id);
    results.push({
      id: `tunnel:${tunnel.id}`,
      kind: 'tunnel',
      tunnel,
      running,
      label: tunnel.name ?? tunnel.target,
      detail: `${running ? 'Running' : 'Stopped'} · ${describeTunnel(tunnel)}`,
      keywords: ['tunnel', 'forward', tunnel.target, tunnel.type],
      priority: running ? 280 : 100,
      showWhenEmpty: !!running,
    });
  }

  return results;
}

/** Session history and ad-hoc connect: the entries the query itself produces. */
function buildQueryResults({
  sshHosts,
  savedHosts,
  history,
  historyQuery,
  directTarget,
}: {
  sshHosts: readonly SshHostEntry[];
  savedHosts: readonly SavedHostProfile[];
  history: readonly SessionLogSummary[];
  historyQuery: string;
  directTarget: string;
}): LauncherResult[] {
  const results: LauncherResult[] = [];

  for (const session of history.slice(0, 12)) {
    results.push({
      id: `history:${session.id}`,
      kind: 'history',
      session,
      historyQuery,
      label: session.title,
      detail: `${session.host} · ${formatTimestamp(session.startedAt)}${session.snippet ? ` · ${stripMarkup(session.snippet)}` : ''}`,
      keywords: ['history', 'session log', session.kind, session.host, session.snippet ?? ''],
      priority: session.status === 'active' ? 180 : 40,
      showWhenEmpty: false,
    });
  }

  // The shape check is cheap and rejects most of what gets typed, so the host
  // scans only run for text that could actually be connected to.
  const target = directTarget.trim();
  if (isQuickConnectTarget(target)) {
    const normalized = target.toLocaleLowerCase();
    const known =
      sshHosts.some((entry) =>
        entry.aliases.some((alias) => alias.toLocaleLowerCase() === normalized),
      ) ||
      savedHosts.some(
        (entry) =>
          entry.name.toLocaleLowerCase() === normalized ||
          entry.metadata.displayName?.toLocaleLowerCase() === normalized,
      );
    if (!known) {
      results.push({
        id: `quick-connect:${target}`,
        kind: 'quick-connect',
        target,
        label: `Connect to ${target}`,
        detail: 'Ad-hoc SSH connection',
        keywords: ['ssh', 'connect', target],
        priority: 720,
        showWhenEmpty: false,
      });
    }
  }

  return results;
}

/** App actions and the searchable keymap, both independent of the query. */
function buildActionResults({
  activeConnected,
  activeSsh,
  keybindings,
}: {
  activeConnected: boolean;
  activeSsh: boolean;
  keybindings: KeybindingOverrides;
}): LauncherResult[] {
  const results: LauncherResult[] = [];

  results.push(
    actionResult('new-local', 'New local terminal', 'Open a fresh local shell', [
      'terminal',
      'shell',
      'local',
    ]),
    actionResult('new-host', 'Add host', 'Create an SSH, Telnet, or serial host', [
      'new',
      'connection',
      'profile',
    ]),
    actionResult('settings', 'Open settings', 'Appearance, terminal, behavior, and shortcuts', [
      'preferences',
      'configure',
    ]),
    actionResult('workspaces', 'Manage workspaces', 'Save or open terminal layouts', [
      'layout',
      'sessions',
    ]),
    actionResult('history', 'Open session history', 'Search retained terminal output', [
      'logs',
      'transcript',
      'replay',
    ]),
    actionResult('commands', 'Manage saved commands', 'Create and edit command buttons', [
      'buttons',
      'snippets',
    ]),
    actionResult('tunnels', 'Open port forwarding', 'Manage saved tunnels and live forwards', [
      'ssh',
      'forward',
      'proxy',
    ]),
    {
      ...actionResult('sftp', 'Toggle file browser', 'Browse files over SFTP for the active SSH session', [
        'files',
        'upload',
        'download',
      ]),
      disabledReason: activeSsh ? undefined : 'Select a connected SSH session first',
    },
    {
      ...actionResult('find-terminal', 'Find in active terminal', 'Search the current terminal buffer', [
        'search',
        'scrollback',
      ]),
      disabledReason: activeConnected ? undefined : 'Select a connected terminal first',
    },
  );

  // Every keyboard command is searchable here, with the chord that runs it —
  // the palette doubles as the discovery path for the keymap.
  for (const command of KEY_COMMANDS) {
    if (command.palette === false) continue;
    const chords = chordLabels(command.id, keybindings);
    results.push({
      id: `keymap:${command.id}`,
      kind: 'keymap',
      command,
      chord: chords[0],
      label: command.title,
      detail: COMMAND_CATEGORY_LABELS[command.category],
      keywords: [...(command.keywords ?? []), ...chords, command.category, 'shortcut'],
      priority: 60,
      showWhenEmpty: false,
    });
  }

  return results;
}

function actionResult(
  action: LauncherAction,
  label: string,
  detail: string,
  keywords: readonly string[],
): LauncherResult {
  return {
    id: `action:${action}`,
    kind: 'action',
    action,
    label,
    detail,
    keywords,
    priority: 70,
    showWhenEmpty: false,
  };
}

function ResultIcon({ result }: { result: LauncherResult }) {
  const props = { fontSize: 'small' as const };
  if (result.kind === 'tab') {
    return result.reconnect ? (
      <PlayArrowOutlinedIcon {...props} color="warning" />
    ) : (
      <TerminalOutlinedIcon
        {...props}
        color={result.detail.startsWith('Connected') ? 'success' : 'primary'}
      />
    );
  }
  if (result.kind === 'editor') return <CodeOutlinedIcon {...props} color="primary" />;
  if (result.kind === 'host' || result.kind === 'quick-connect') {
    return <DnsOutlinedIcon {...props} color="primary" />;
  }
  if (result.kind === 'workspace') return <WorkspacesOutlinedIcon {...props} />;
  if (result.kind === 'command') return <BoltOutlinedIcon {...props} color="warning" />;
  if (result.kind === 'tunnel') {
    return result.running ? (
      <StopOutlinedIcon {...props} color="success" />
    ) : (
      <SwapHorizOutlinedIcon {...props} />
    );
  }
  if (result.kind === 'history') return <HistoryOutlinedIcon {...props} />;
  if (result.kind === 'keymap') return <KeyboardOutlinedIcon {...props} />;
  if (result.action === 'settings') return <SettingsOutlinedIcon {...props} />;
  if (result.action === 'workspaces') return <WorkspacesOutlinedIcon {...props} />;
  if (result.action === 'history') return <HistoryOutlinedIcon {...props} />;
  if (result.action === 'commands') return <BoltOutlinedIcon {...props} />;
  if (result.action === 'tunnels') return <SwapHorizOutlinedIcon {...props} />;
  if (result.action === 'sftp') return <FolderOutlinedIcon {...props} />;
  if (result.action === 'new-host') return <DnsOutlinedIcon {...props} />;
  return <TerminalOutlinedIcon {...props} />;
}

function ResultKindLabel({
  result,
  busy,
}: {
  result: LauncherResult;
  busy: boolean;
}) {
  if (busy) return <CircularProgress size={16} sx={{ ml: 1 }} />;
  if (result.kind === 'keymap') {
    return result.chord ? (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ ml: 1.5, fontFamily: '"JetBrains Mono", monospace', whiteSpace: 'nowrap' }}
      >
        {result.chord}
      </Typography>
    ) : null;
  }
  const label =
    result.kind === 'quick-connect'
      ? 'CONNECT'
      : result.kind === 'editor'
        ? 'FILE'
        : result.kind.toUpperCase();
  return (
    <Typography
      variant="caption"
      color="text.disabled"
      sx={{ ml: 1.5, fontSize: 9.5, letterSpacing: 0.5 }}
    >
      {label}
    </Typography>
  );
}

function KeyHint({ keys, label }: { keys: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      <Box
        component="kbd"
        sx={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10,
          color: 'text.primary',
        }}
      >
        {keys}
      </Box>
      <Typography variant="caption">{label}</Typography>
    </Stack>
  );
}

function profileSummary(profile: SessionProfile): string {
  if (profile.kind === 'ssh') return `SSH · ${profile.target}`;
  if (profile.kind === 'telnet') return `Telnet · ${profile.host}:${profile.port}`;
  if (profile.kind === 'serial') return `Serial · ${profile.path}`;
  return `Local${profile.cwd ? ` · ${profile.cwd}` : ''}`;
}

function tabStatusLabel(status: TabStatus): string {
  if (status === 'connected') return 'Connected';
  if (status === 'connecting') return 'Connecting';
  if (status === 'interrupted') return 'Connection interrupted';
  return 'Disconnected — reconnect';
}

function describeTunnel(tunnel: TunnelRecord): string {
  if (tunnel.type === 'dynamic') {
    return `SOCKS localhost:${tunnel.bindPort} via ${tunnel.target}`;
  }
  return `${tunnel.type === 'local' ? 'Local' : 'Remote'} ${tunnel.bindPort} → ${tunnel.targetHost}:${tunnel.targetPort} via ${tunnel.target}`;
}

function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ↵ ').trim();
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}
