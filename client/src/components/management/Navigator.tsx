import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';
import HistoryIcon from '@mui/icons-material/History';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatGnmiPath, type SavedManagementRequest } from '@muxus/shared';
import { apiFetch } from '../../api/http.js';
import { copyToClipboard } from '../../clipboard.js';
import { confirmAction, promptForText } from '../../state/dialogs.js';
import { showErrorToast, showToast } from '../../state/toast.js';
import type { DataNode } from '../../management/data-tree.js';
import { formatSi } from '../../management/live-table.js';
import { defaultNetconfDraft, draftSummary, normalizeDraft, type ManagementDraft } from '../../management/requests.js';
import { runLabel } from '../../management/controller.js';
import type { NavigatorTab, RunRecord } from '../../management/workbench-store.js';
import { useWorkbench, useWorkbenchState } from './context.js';
import { DataTreeView } from './DataTreeView.js';
import { helloModules } from './NetconfForm.js';
import { prettyXml } from '../../management/xml.js';
import { NodeMenu, NodeRowActions, useNodeActions } from './node-actions.js';
import { MONO_FONT, PathText } from './PathText.js';
import { REQUESTS_QUERY_KEY } from './RequestEditor.js';
import { netconfFailed, StatusIcon } from './ResultPane.js';

export function Navigator() {
  const { store } = useWorkbench();
  const tab = useWorkbenchState((state) => state.navigator);
  const history = useWorkbenchState((state) => state.runs.filter((run) => !run.hidden).length);
  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Tabs
        value={tab}
        onChange={(_event, value: NavigatorTab) => store.getState().setNavigator(value)}
        variant="fullWidth"
        sx={{
          minHeight: 38,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
          '& .MuiTab-root': { minHeight: 38, minWidth: 0, px: 0.5, textTransform: 'none', fontSize: 12.5, fontWeight: 550 },
        }}
      >
        <Tab value="explore" label="Explore" />
        <Tab value="library" label="Saved" />
        <Tab
          value="history"
          label={
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <span>History</span>
              {history > 0 && (
                <Box
                  component="span"
                  sx={{ fontSize: 10, lineHeight: '15px', px: 0.6, borderRadius: 8, bgcolor: 'action.selected', color: 'text.secondary' }}
                >
                  {history}
                </Box>
              )}
            </Stack>
          }
        />
        <Tab value="device" label="Device" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'explore' && <ExplorerPanel />}
        {tab === 'library' && <LibraryPanel />}
        {tab === 'history' && <HistoryPanel />}
        {tab === 'device' && <DevicePanel />}
      </Box>
    </Box>
  );
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        px: 1,
        height: 30,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
        flex: 1,
        minWidth: 0,
      }}
    >
      <SearchIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
      <InputBase
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputProps={{ 'aria-label': placeholder, spellCheck: false }}
        sx={{ fontSize: 12.5, flex: 1 }}
      />
    </Box>
  );
}

// Explorer

function ExplorerPanel() {
  const { controller, store, connected, profile } = useWorkbench();
  const explorer = useWorkbenchState((state) => state.explorer);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ node: DataNode; x: number; y: number } | null>(null);
  const root = explorer.root;
  const actions = useNodeActions(root);
  const rootLoading = explorer.loading.has('');
  const rootError = explorer.errors.get('');

  // Load the top level once connected.
  useEffect(() => {
    if (connected && !root.loaded && !explorer.loading.has('') && !explorer.errors.has('')) void controller.loadNode(root);
  }, [connected, controller, root, explorer]);

  const toggle = (node: DataNode, expand: boolean) => {
    if (expand && !node.loaded && connected && node.kind !== 'leaf' && node.kind !== 'leaf-list') {
      void controller.loadNode(node);
      return;
    }
    store.getState().touchExplorer((current) => {
      if (expand) current.expanded.add(node.id);
      else current.expanded.delete(node.id);
    });
  };
  const select = (node: DataNode) => store.getState().touchExplorer((current) => (current.selected = node.id));
  const selected = useMemo(() => {
    if (!explorer.selected) return undefined;
    const find = (node: DataNode): DataNode | undefined => {
      if (node.id === explorer.selected) return node;
      for (const child of node.children) {
        const found = find(child);
        if (found) return found;
      }
      return undefined;
    };
    return find(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorer.selected, explorer.version, root]);

  const scopeLabels = { config: 'Config', all: 'Config + state' };

  return (
    <>
      <Stack direction="row" spacing={0.75} sx={{ p: 1, alignItems: 'center', flexShrink: 0 }}>
        <SearchField value={filter} onChange={setFilter} placeholder="Filter loaded data" />
        <Tooltip title="Reload">
          <span>
            <IconButton
              size="small"
              aria-label="Reload the explorer"
              disabled={!connected}
              onClick={() => store.getState().resetExplorer()}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Box sx={{ px: 1, pb: 0.75, flexShrink: 0 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          fullWidth
          value={explorer.scope}
          onChange={(_event, scope: 'config' | 'all' | null) => scope && store.getState().resetExplorer(scope)}
          sx={{ '& .MuiToggleButton-root': { py: 0.2, fontSize: 11.5 } }}
        >
          <ToggleButton value="all">{scopeLabels.all}</ToggleButton>
          <ToggleButton value="config">{scopeLabels.config}</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, borderTop: 1, borderColor: 'divider' }}>
        {rootLoading && root.children.length === 0 ? (
          <Stack spacing={1} sx={{ p: 3, alignItems: 'center' }}>
            <CircularProgress size={20} />
            <Typography variant="caption" color="textSecondary">
              {profile.kind === 'gnmi' ? 'Reading the top of the tree …' : 'Reading the configuration …'}
            </Typography>
          </Stack>
        ) : rootError ? (
          <Stack spacing={1} sx={{ p: 2 }}>
            <Typography variant="body2" color="error">
              {rootError}
            </Typography>
            <Button size="small" onClick={() => void controller.loadNode(root)} sx={{ alignSelf: 'flex-start' }}>
              Try again
            </Button>
          </Stack>
        ) : (
          <DataTreeView
            root={root}
            expanded={explorer.expanded}
            version={explorer.version}
            onToggle={toggle}
            selectedId={explorer.selected}
            onSelect={select}
            onActivate={(node) => connected && actions.get(node)}
            onContextMenu={(node, event) => setMenu({ node, x: event.clientX, y: event.clientY })}
            renderRowActions={(node) => <NodeRowActions node={node} root={root} />}
            loading={explorer.loading}
            errors={explorer.errors}
            filter={filter}
            lazy={profile.kind === 'gnmi' || explorer.scope === 'all'}
            ariaLabel="Device data"
            empty={
              <Typography variant="body2" color="textSecondary">
                {connected ? (filter ? 'Nothing loaded matches.' : 'The device returned no data.') : 'Connect to browse the device.'}
              </Typography>
            }
          />
        )}
      </Box>
      {selected && selected.kind !== 'root' && (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ px: 1, py: 0.5, borderTop: 1, borderColor: 'divider', alignItems: 'center', flexShrink: 0, bgcolor: 'background.paper' }}
        >
          <Box sx={{ flex: 1, minWidth: 0, fontSize: 11.5, maxHeight: 48, overflow: 'auto' }}>
            <PathText path={selected.path} />
          </Box>
          <Tooltip title="Copy path">
            <IconButton
              size="small"
              aria-label="Copy path"
              onClick={() =>
                void copyToClipboard(formatGnmiPath(selected.path)).then((ok) =>
                  showToast(ok ? 'success' : 'error', ok ? 'Copied the path.' : 'Could not copy.'),
                )
              }
            >
              <ContentCopyIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        </Stack>
      )}
      <NodeMenu target={menu} root={root} onClose={() => setMenu(null)} />
    </>
  );
}

// Library

function useSavedRequests() {
  const { profile } = useWorkbench();
  return useQuery({
    queryKey: [REQUESTS_QUERY_KEY, profile.kind, profile.profileId ?? ''],
    queryFn: () =>
      apiFetch<{ requests: SavedManagementRequest[] }>(
        `/api/management/requests?protocol=${profile.kind}${profile.profileId ? `&profileId=${encodeURIComponent(profile.profileId)}` : ''}`,
      ),
  });
}

function LibraryPanel() {
  const { store, controller, connected, profile, title } = useWorkbench();
  const queryClient = useQueryClient();
  const { data, isLoading } = useSavedRequests();
  const [filter, setFilter] = useState('');
  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/management/requests/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [REQUESTS_QUERY_KEY] }),
    onError: showErrorToast,
  });
  const rename = useMutation({
    mutationFn: (request: SavedManagementRequest) =>
      apiFetch('/api/management/requests', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: request.id,
          protocol: request.protocol,
          ...(request.profileId ? { profileId: request.profileId } : {}),
          name: request.name,
          request: request.request,
        }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [REQUESTS_QUERY_KEY] }),
    onError: showErrorToast,
  });
  const requests = (data?.requests ?? []).filter((request) =>
    filter.trim() ? request.name.toLowerCase().includes(filter.trim().toLowerCase()) : true,
  );
  const own = requests.filter((request) => request.profileId);
  const shared = requests.filter((request) => !request.profileId);
  const load = (request: SavedManagementRequest, run: boolean) => {
    const draft = normalizeDraft(profile.kind as 'gnmi', request.request) as ManagementDraft;
    store.getState().replaceDraft(draft);
    if (run) controller.run(draft);
  };

  const section = (label: string, items: SavedManagementRequest[]) =>
    items.length > 0 && (
      <Box>
        <Typography
          variant="caption"
          sx={{ display: 'block', px: 1.5, pt: 1, pb: 0.5, color: 'text.secondary', fontWeight: 650, textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10.5 }}
        >
          {label}
        </Typography>
        {items.map((request) => {
          const draft = normalizeDraft(profile.kind as 'gnmi', request.request) as ManagementDraft;
          return (
            <Box
              key={request.id}
              onClick={() => load(request, false)}
              onDoubleClick={() => load(request, true)}
              sx={(theme) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 0.75,
                cursor: 'pointer',
                '&:hover': { bgcolor: alpha(theme.palette.text.primary, 0.05) },
                '&:hover .library-actions': { opacity: 1 },
              })}
            >
              <Chip label={runLabel(draft)} size="small" sx={{ height: 18, fontSize: 10.5, flexShrink: 0 }} />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 550 }}>
                  {request.name}
                </Typography>
                <Typography variant="caption" color="textSecondary" noWrap sx={{ display: 'block', fontFamily: MONO_FONT, fontSize: 10.5 }}>
                  {draftSummary(draft)}
                </Typography>
              </Box>
              <Stack direction="row" className="library-actions" sx={{ opacity: 0, transition: 'opacity 100ms ease' }} onClick={(event) => event.stopPropagation()}>
                <Tooltip title="Run">
                  <span>
                    <IconButton size="small" aria-label={`Run ${request.name}`} disabled={!connected} onClick={() => load(request, true)}>
                      <PlayArrowRoundedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="Rename">
                  <IconButton
                    size="small"
                    aria-label={`Rename ${request.name}`}
                    onClick={() =>
                      void promptForText({ title: 'Rename request', label: 'Name', initialValue: request.name }).then((name) => {
                        if (name?.trim()) rename.mutate({ ...request, name: name.trim() });
                      })
                    }
                  >
                    <EditNoteOutlinedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete">
                  <IconButton
                    size="small"
                    aria-label={`Delete ${request.name}`}
                    onClick={() =>
                      void confirmAction({
                        title: `Delete “${request.name}”?`,
                        confirmLabel: 'Delete',
                        destructive: true,
                      }).then((confirmed) => {
                        if (confirmed) remove.mutate(request.id);
                      })
                    }
                  >
                    <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Box>
          );
        })}
      </Box>
    );

  return (
    <>
      <Stack direction="row" spacing={0.75} sx={{ p: 1, flexShrink: 0 }}>
        <SearchField value={filter} onChange={setFilter} placeholder="Find a saved request" />
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', pb: 1 }}>
        {isLoading ? (
          <Box sx={{ p: 2, display: 'flex', justifyContent: 'center' }}>
            <CircularProgress size={18} />
          </Box>
        ) : requests.length === 0 ? (
          <Stack spacing={1} sx={{ p: 2.5, alignItems: 'center', textAlign: 'center' }}>
            <BookmarkBorderIcon sx={{ fontSize: 28, color: 'text.disabled' }} />
            <Typography variant="body2" color="textSecondary">
              {filter ? 'No saved request matches.' : 'Requests you save with the bookmark button above the editor appear here, for this host or every host.'}
            </Typography>
          </Stack>
        ) : (
          <>
            {section(`${title}`, own)}
            {section(`Every ${profile.kind === 'gnmi' ? 'gNMI' : 'NETCONF'} host`, shared)}
          </>
        )}
      </Box>
    </>
  );
}

// History

function HistoryPanel() {
  const { store, controller, connected } = useWorkbench();
  const runs = useWorkbenchState((state) => state.runs);
  const selectedRunId = useWorkbenchState((state) => state.selectedRunId);
  const visible = runs.filter((run) => !run.hidden);
  return (
    <>
      <Stack direction="row" sx={{ px: 1.5, py: 0.75, alignItems: 'center', flexShrink: 0 }}>
        <Typography variant="caption" color="textSecondary" sx={{ flex: 1 }}>
          Click to show a result · double-click to run again
        </Typography>
        <Button size="small" color="inherit" disabled={visible.length === 0} onClick={() => store.getState().clearHistory()} sx={{ fontSize: 12 }}>
          Clear
        </Button>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', borderTop: 1, borderColor: 'divider' }}>
        {visible.length === 0 ? (
          <Stack spacing={1} sx={{ p: 2.5, alignItems: 'center', textAlign: 'center' }}>
            <HistoryIcon sx={{ fontSize: 28, color: 'text.disabled' }} />
            <Typography variant="body2" color="textSecondary">
              Every request you run is kept here with its result until the tab closes.
            </Typography>
          </Stack>
        ) : (
          visible.map((run) => (
            <HistoryRow
              key={run.id}
              run={run}
              selected={run.id === selectedRunId}
              onSelect={() => store.getState().selectRun(run.id)}
              onLoad={() => store.getState().replaceDraft(structuredClone(run.draft))}
              onRerun={() => {
                if (!connected) return;
                store.getState().replaceDraft(structuredClone(run.draft));
                controller.run(run.draft);
              }}
              onStop={() => controller.cancel(run.id)}
            />
          ))
        )}
      </Box>
    </>
  );
}

function HistoryRow({
  run,
  selected,
  onSelect,
  onLoad,
  onRerun,
  onStop,
}: {
  run: RunRecord;
  selected: boolean;
  onSelect: () => void;
  onLoad: () => void;
  onRerun: () => void;
  onStop: () => void;
}) {
  const time = new Date(run.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const meta = [
    run.status === 'streaming' ? 'live' : run.durationMs !== undefined ? `${run.durationMs} ms` : undefined,
    run.bytes !== undefined ? `${formatSi(run.bytes)}B` : undefined,
    time,
  ].filter(Boolean);
  const failed = run.status === 'error' || netconfFailed(run);
  return (
    <Box
      onClick={onSelect}
      onDoubleClick={onRerun}
      sx={(theme) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 0.75,
        cursor: 'pointer',
        borderLeft: 2,
        borderColor: selected ? 'primary.main' : 'transparent',
        bgcolor: selected ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
        '&:hover': { bgcolor: selected ? alpha(theme.palette.primary.main, 0.12) : alpha(theme.palette.text.primary, 0.05) },
        '&:hover .history-actions': { opacity: 1 },
      })}
    >
      <StatusIcon run={run} size={15} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline' }}>
          <Typography variant="body2" sx={{ fontWeight: 600, color: failed ? 'error.main' : 'text.primary', flexShrink: 0 }}>
            {run.label}
          </Typography>
          <Typography variant="caption" color="textSecondary" noWrap sx={{ fontFamily: MONO_FONT, fontSize: 11, minWidth: 0 }}>
            {run.summary}
          </Typography>
        </Stack>
        <Typography variant="caption" color="textSecondary" sx={{ fontSize: 10.5 }}>
          {failed && run.error ? `${run.error.code ?? 'Error'} · ` : ''}
          {meta.join(' · ')}
        </Typography>
      </Box>
      <Stack direction="row" className="history-actions" sx={{ opacity: 0, transition: 'opacity 100ms ease' }} onClick={(event) => event.stopPropagation()}>
        {run.status === 'streaming' ? (
          <Tooltip title="Stop">
            <IconButton size="small" aria-label="Stop" onClick={onStop}>
              <StopRoundedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Run again">
            <IconButton size="small" aria-label="Run again" onClick={onRerun}>
              <PlayArrowRoundedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Load into the editor">
          <IconButton size="small" aria-label="Load into the editor" onClick={onLoad}>
            <EditNoteOutlinedIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  );
}

// Device

const NETCONF_CAPABILITIES: Array<{ fragment: string; label: string; detail: string }> = [
  { fragment: ':candidate', label: 'Candidate', detail: 'Stage changes, then commit' },
  { fragment: ':confirmed-commit', label: 'Confirmed commit', detail: 'Roll back unless confirmed' },
  { fragment: ':validate', label: 'Validate', detail: 'Check without applying' },
  { fragment: ':rollback-on-error', label: 'Rollback on error', detail: 'All or nothing edits' },
  { fragment: ':writable-running', label: 'Writable running', detail: 'Edit running directly' },
  { fragment: ':startup', label: 'Startup', detail: 'Separate startup datastore' },
  { fragment: ':xpath', label: 'XPath', detail: 'XPath filters' },
  { fragment: ':notification', label: 'Notifications', detail: 'Event streams' },
  { fragment: ':with-defaults', label: 'With-defaults', detail: 'Control default values in replies' },
  { fragment: ':url', label: 'URL', detail: 'Copy configs to and from URLs' },
];

function InfoRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
      <Typography variant="caption" color="textSecondary" sx={{ width: 84, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ fontFamily: MONO_FONT, fontSize: 11, wordBreak: 'break-all' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function DevicePanel() {
  const { controller, store, connected } = useWorkbench();
  const [filter, setFilter] = useState('');
  const banner = useWorkbenchState((state) => state.banner);
  const notifications = useWorkbenchState((state) => state.notifications);
  const info = controller.info;
  if (!info) return null;
  const needle = filter.trim().toLowerCase();

  if (info.protocol === 'gnmi') {
    const models = info.models.filter((model) =>
      needle ? `${model.name} ${model.organization} ${model.version}`.toLowerCase().includes(needle) : true,
    );
    return (
      <>
        <Stack spacing={0.5} sx={{ p: 1.5, flexShrink: 0, borderBottom: 1, borderColor: 'divider' }}>
          <InfoRow label="gNMI" value={info.version} />
          <InfoRow label="Encodings" value={info.encodings.map((encoding) => encoding.toUpperCase()).join(', ')} />
          <InfoRow label="Address" value={info.address} />
          <InfoRow label="Via" value={info.via} />
          <InfoRow label="TLS" value={info.tls.mode === 'plaintext' ? 'none' : `${info.tls.protocol ?? ''} ${info.tls.verified ? 'verified' : info.tls.mode === 'skip-verify' ? 'not verified' : 'pinned'}`.trim()} />
          <InfoRow label="Certificate" value={info.tls.subject} />
          <InfoRow label="Connected" value={new Date(info.connectedAt).toLocaleString()} />
        </Stack>
        <Stack direction="row" sx={{ p: 1, flexShrink: 0 }}>
          <SearchField value={filter} onChange={setFilter} placeholder={`Find among ${info.models.length} models`} />
        </Stack>
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {models.map((model) => (
            <Box key={`${model.name}@${model.version}`} sx={{ px: 1.5, py: 0.5 }}>
              <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 11.5, wordBreak: 'break-all' }}>
                {model.name}
              </Typography>
              <Typography variant="caption" color="textSecondary" sx={{ fontSize: 10.5 }}>
                {[model.organization, model.version].filter(Boolean).join(' · ')}
              </Typography>
            </Box>
          ))}
        </Box>
      </>
    );
  }

  const modules = helloModules(info.capabilities).filter((module) => (needle ? module.name.toLowerCase().includes(needle) : true));

  const canSchema = controller.hasCapability('ietf-netconf-monitoring');
  const openSchema = (name: string, revision?: string) => {
    const draft = { ...defaultNetconfDraft(), operation: 'get-schema' as const, schemaIdentifier: name, schemaVersion: revision ?? '' };
    store.getState().replaceDraft(draft);
    controller.run(draft);
  };
  return (
    <>
      <Stack spacing={0.5} sx={{ p: 1.5, flexShrink: 0, borderBottom: 1, borderColor: 'divider' }}>
        <InfoRow label="Session" value={info.sessionId} />
        <InfoRow label="Framing" value={info.base === '1.1' ? 'base:1.1 (chunked)' : 'base:1.0 (]]>]]>)'} />
        <InfoRow label="Address" value={info.address} />
        <InfoRow label="Via" value={info.via} />
        <InfoRow label="Connected" value={new Date(info.connectedAt).toLocaleString()} />
        {banner && (
          <Tooltip
            title={<Box component="pre" sx={{ m: 0, fontFamily: MONO_FONT, fontSize: 10.5, whiteSpace: 'pre' }}>{banner}</Box>}
            slotProps={{ tooltip: { sx: { maxWidth: 'none' } } }}
          >
            <Typography variant="caption" color="primary" sx={{ cursor: 'default', alignSelf: 'flex-start' }}>
              Login banner
            </Typography>
          </Tooltip>
        )}
        <Stack direction="row" useFlexGap spacing={0.5} sx={{ flexWrap: 'wrap', pt: 0.75 }}>
          {NETCONF_CAPABILITIES.map((capability) => {
            const supported = controller.hasCapability(capability.fragment);
            return (
              <Tooltip key={capability.fragment} title={`${capability.detail}${supported ? '' : ' — not supported'}`}>
                <Chip
                  size="small"
                  variant={supported ? 'filled' : 'outlined'}
                  icon={supported ? <CheckRoundedIcon /> : undefined}
                  label={capability.label}
                  sx={{ height: 20, fontSize: 10.5, opacity: supported ? 1 : 0.5, '& .MuiChip-icon': { fontSize: 13 } }}
                />
              </Tooltip>
            );
          })}
        </Stack>
      </Stack>
      {notifications.length > 0 && <NotificationList notifications={notifications} />}
      <Stack direction="row" sx={{ p: 1, flexShrink: 0 }}>
        <SearchField value={filter} onChange={setFilter} placeholder={`Find among ${helloModules(info.capabilities).length} YANG modules`} />
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {modules.map((module) => (
          <Box
            key={`${module.name}@${module.revision ?? ''}`}
            onClick={() => canSchema && connected && openSchema(module.name, module.revision)}
            sx={(theme) => ({
              px: 1.5,
              py: 0.5,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              cursor: canSchema ? 'pointer' : 'default',
              '&:hover': canSchema ? { bgcolor: alpha(theme.palette.text.primary, 0.05) } : undefined,
            })}
          >
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 11.5, wordBreak: 'break-all' }}>
                {module.name}
              </Typography>
              <Typography variant="caption" color="textSecondary" sx={{ fontSize: 10.5 }}>
                {module.revision ?? 'no revision'}
              </Typography>
            </Box>
            {canSchema && (
              <Tooltip title="Open the YANG module (get-schema)">
                <DescriptionOutlinedIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
              </Tooltip>
            )}
          </Box>
        ))}
      </Box>
    </>
  );
}

/** The event a NETCONF notification reports: its first element after eventTime. */
function notificationEvent(xml: string): string {
  const body = xml.replace(/<(\w+:)?eventTime>[^<]*<\/(\w+:)?eventTime>/, '');
  const match = /<(?!\?|\/|(?:\w+:)?notification[\s>])(?:[\w.-]+:)?([\w.-]+)/.exec(body);
  return match?.[1] ?? 'notification';
}

function NotificationList({ notifications }: { notifications: Array<{ xml: string; eventTime?: string; receivedAt: string }> }) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', maxHeight: '40%', overflow: 'auto', flexShrink: 0 }}>
      <Typography
        variant="caption"
        sx={{ display: 'block', px: 1.5, pt: 1, pb: 0.5, color: 'text.secondary', fontWeight: 650, textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10.5 }}
      >
        Notifications · {notifications.length}
      </Typography>
      {notifications.map((notification, index) => (
        <Box key={`${notification.receivedAt}-${index}`} sx={{ px: 1.5, py: 0.25 }}>
          <Box
            component="button"
            type="button"
            onClick={() => setOpen(open === index ? undefined : index)}
            sx={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 1, width: '100%', alignItems: 'baseline' }}
          >
            <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 11.5, flex: 1, minWidth: 0 }} noWrap>
              {notificationEvent(notification.xml)}
            </Typography>
            <Typography variant="caption" color="textSecondary" sx={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
              {new Date(notification.eventTime ?? notification.receivedAt).toLocaleTimeString()}
            </Typography>
          </Box>
          {open === index && (
            <Box component="pre" sx={{ m: 0, mt: 0.5, p: 1, borderRadius: 1, bgcolor: 'background.paper', fontFamily: MONO_FONT, fontSize: 10.5, overflow: 'auto', maxHeight: 220 }}>
              {prettyXml(notification.xml)}
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
