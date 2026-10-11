import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import ErrorRoundedIcon from '@mui/icons-material/ErrorRounded';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import SearchIcon from '@mui/icons-material/Search';
import TableRowsOutlinedIcon from '@mui/icons-material/TableRowsOutlined';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import {
  formatGnmiPath,
  parseGnmiPath,
  splitPathOptions,
  tryParseGnmiPath,
  type GnmiNotification,
  type ManagementResult,
} from '@muxus/shared';
import { copyToClipboard } from '../../clipboard.js';
import { HOTKEY_MOD_LABEL } from '../../platform.js';
import { exportFilename, saveTextFile } from '../../save-file.js';
import { showToast } from '../../state/toast.js';
import {
  collectLeaves,
  countLeaves,
  createRoot,
  KeyRegistry,
  mergeJson,
  mergeXml,
  nodeAt,
  nodeToJson,
  type DataNode,
} from '../../management/data-tree.js';
import { formatSi } from '../../management/live-table.js';
import {
  defaultGnmiDraft,
  defaultNetconfDraft,
  type GnmiDraft,
  type ManagementDraft,
  type NetconfDraft,
} from '../../management/requests.js';
import { canonicalJson } from '../../management/set-review.js';
import type { RunRecord } from '../../management/workbench-store.js';
import { parseRpcReply, prettyXml, type RpcErrorInfo } from '../../management/xml.js';
import { CodeEditor } from './CodeEditor.js';
import { useWorkbench, useWorkbenchState } from './context.js';
import { DataTreeView } from './DataTreeView.js';
import { LiveView } from './LiveView.js';
import { NodeMenu, NodeRowActions } from './node-actions.js';
import { MONO_FONT, PathText, valueColorSx, valueText } from './PathText.js';
import { ReviewDialog } from './ReviewDialog.js';

export function ResultPane() {
  const run = useWorkbenchState((state) => state.runs.find((candidate) => candidate.id === state.selectedRunId));
  if (!run) return <EmptyResult />;
  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {!run.live && <RunHeader run={run} />}
      <RunBody run={run} />
    </Box>
  );
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function StatusIcon({ run, size = 16 }: { run: RunRecord; size?: number }) {
  if (run.status === 'running') return <CircularProgress size={size - 3} thickness={5} />;
  if (run.status === 'streaming') return <MonitorHeartOutlinedIcon sx={{ fontSize: size, color: 'success.main' }} />;
  if (run.status === 'error' || netconfFailed(run)) return <ErrorRoundedIcon sx={{ fontSize: size, color: 'error.main' }} />;
  if (run.status === 'cancelled') return <ErrorRoundedIcon sx={{ fontSize: size, color: 'text.disabled' }} />;
  return <CheckCircleRoundedIcon sx={{ fontSize: size, color: 'success.main' }} />;
}

/** A NETCONF reply that carried <rpc-error> counts as failed even though the RPC itself completed. */
export function netconfFailed(run: RunRecord): boolean {
  return run.result?.op === 'netconf-rpc' && /<(\w+:)?rpc-error[\s>]/.test(run.result.xml);
}

function RunHeader({ run }: { run: RunRecord }) {
  const meta = [
    run.durationMs !== undefined ? `${run.durationMs} ms` : undefined,
    run.bytes !== undefined ? `${formatSi(run.bytes)}B` : undefined,
    timeOf(run.startedAt),
  ].filter(Boolean);
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: 'center', px: 1.5, minHeight: 36, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
    >
      <StatusIcon run={run} />
      <Typography variant="body2" sx={{ fontWeight: 650 }}>
        {run.label}
      </Typography>
      <Typography
        variant="body2"
        color="textSecondary"
        noWrap
        sx={{ fontFamily: MONO_FONT, fontSize: 12, minWidth: 0, flexShrink: 1 }}
        title={run.summary}
      >
        {run.summary}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <Typography variant="caption" color="textSecondary" sx={{ whiteSpace: 'nowrap' }}>
        {meta.join(' · ')}
      </Typography>
    </Stack>
  );
}

function RunBody({ run }: { run: RunRecord }) {
  const { controller } = useWorkbench();
  if (run.live) return <LiveView run={run} />;
  if (run.status === 'running') {
    return (
      <Stack spacing={1.5} sx={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <CircularProgress size={28} />
        <Typography variant="body2" color="textSecondary">
          Waiting for the device …
        </Typography>
        <Button size="small" color="inherit" onClick={() => controller.cancel(run.id)}>
          Cancel (Esc)
        </Button>
      </Stack>
    );
  }
  if (run.status === 'error' || run.status === 'cancelled') return <ErrorView run={run} />;
  const result = run.result;
  if (!result) return null;
  if (result.op === 'gnmi-get') return <GnmiGetView run={run} notifications={result.notifications} />;
  if (result.op === 'gnmi-set') return <SetResultView run={run} result={result} />;
  if (result.op === 'netconf-rpc') return <NetconfReplyView run={run} xml={result.xml} />;
  return null;
}

// Errors

function ErrorView({ run }: { run: RunRecord }) {
  const { store, controller } = useWorkbench();
  const error = run.error ?? { message: 'Failed.' };
  const { bad, options } = splitPathOptions(error.message);
  const draft = run.draft;
  const fix = (option: string) => {
    if (draft.protocol !== 'gnmi' || !bad) return;
    const replace = (path: string) => {
      const parsed = tryParseGnmiPath(path);
      if (!parsed) return path;
      return formatGnmiPath({
        ...parsed,
        elems: parsed.elems.map((elem) =>
          elem.name.replace(/^.*:/, '') === bad ? { ...elem, name: option } : elem,
        ),
      });
    };
    const next: GnmiDraft = {
      ...draft,
      paths: draft.paths.map(replace),
      set: draft.set.map((item) => ({ ...item, path: replace(item.path) })),
    };
    store.getState().replaceDraft(next);
    if (next.operation !== 'set') controller.run(next);
  };
  return (
    <Box sx={{ p: 2, overflow: 'auto' }}>
      <Alert
        severity={run.status === 'cancelled' ? 'info' : 'error'}
        variant="outlined"
        icon={run.status === 'cancelled' ? undefined : <ErrorRoundedIcon />}
        sx={{ '& .MuiAlert-message': { width: '100%' } }}
      >
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="body2" sx={{ fontWeight: 650 }}>
              {run.status === 'cancelled' ? 'Cancelled' : `${run.label} failed`}
            </Typography>
            {error.code && <Chip size="small" label={error.code} sx={{ height: 20, fontFamily: MONO_FONT, fontSize: 11 }} />}
          </Stack>
          <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {error.message}
          </Typography>
          {bad && options.length > 0 && draft.protocol === 'gnmi' && (
            <Stack spacing={0.75}>
              <Typography variant="caption" color="textSecondary">
                The device offers these instead of “{bad}”:
              </Typography>
              <Stack direction="row" useFlexGap spacing={0.5} sx={{ flexWrap: 'wrap' }}>
                {options.map((option) => (
                  <Chip
                    key={option}
                    size="small"
                    label={option}
                    onClick={() => fix(option)}
                    sx={{ fontFamily: MONO_FONT, fontSize: 11.5 }}
                  />
                ))}
              </Stack>
            </Stack>
          )}
          {hintFor(error.code, error.message) && (
            <Typography variant="caption" color="textSecondary">
              {hintFor(error.code, error.message)}
            </Typography>
          )}
        </Stack>
      </Alert>
    </Box>
  );
}

function hintFor(code: string | undefined, message: string): string | undefined {
  if (code === 'UNAUTHENTICATED') return 'The device rejected the login. Reconnect to enter the credentials again.';
  if (code === 'PERMISSION_DENIED') return 'The user may read but not change this, or not see this path at all.';
  if (code === 'UNIMPLEMENTED') return 'The device does not implement this RPC or option.';
  if (code === 'RESOURCE_EXHAUSTED') return 'Narrow the path, or ask for less with Depth or a data type.';
  if (/sample interval/i.test(message)) return 'Raise the sample interval in the Subscribe options.';
  return undefined;
}

// gNMI Get

function treeFromNotifications(notifications: readonly GnmiNotification[], registry: KeyRegistry): DataNode {
  const root = createRoot();
  for (const notification of notifications) {
    for (const update of notification.updates) {
      try {
        const node = nodeAt(root, parseGnmiPath(update.path), registry);
        mergeJson(node, update.value.value, registry);
      } catch {
        /* an unparseable path stays visible in the raw view */
      }
    }
  }
  return root;
}

/** Open the path down to the data and, for small results, everything. */
function initialExpansion(root: DataNode, requested: readonly string[]): Set<string> {
  const expanded = new Set<string>();
  const total = countLeaves(root);
  const walk = (node: DataNode, depth: number) => {
    const small = total <= 400;
    if (node.kind !== 'leaf' && node.kind !== 'leaf-list' && (small || depth < 2 || node.children.length === 1)) {
      expanded.add(node.id);
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  for (const child of root.children) walk(child, 0);
  void requested;
  return expanded;
}

function useTreeState(root: DataNode, requested: readonly string[]) {
  const [expanded, setExpanded] = useState(() => initialExpansion(root, requested));
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setExpanded(initialExpansion(root, requested));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  const toggle = (node: DataNode, expand: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (expand) next.add(node.id);
      else next.delete(node.id);
      return next;
    });
    setVersion((value) => value + 1);
  };
  const expandAll = () => {
    const next = new Set<string>();
    const walk = (node: DataNode) => {
      if (node.children.length) next.add(node.id);
      for (const child of node.children) walk(child);
    };
    walk(root);
    setExpanded(next);
  };
  const collapseAll = () => setExpanded(new Set());
  return { expanded, version, toggle, expandAll, collapseAll };
}

function ViewToggle({ value, onChange, options }: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; icon: ReactNode }>;
}) {
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={value}
      onChange={(_event, next: string | null) => next && onChange(next)}
      sx={{ '& .MuiToggleButton-root': { py: 0.25, px: 0.9, fontSize: 11.5, gap: 0.5 } }}
    >
      {options.map((option) => (
        <ToggleButton key={option.value} value={option.value} aria-label={option.label}>
          {option.icon}
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

function FilterBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, height: 28, border: 1, borderColor: 'divider', borderRadius: 1, width: 190 }}>
      <SearchIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
      <InputBase
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter"
        inputProps={{ 'aria-label': 'Filter the result' }}
        sx={{ fontSize: 12.5, flex: 1 }}
      />
    </Box>
  );
}

function sameRequest(a: ManagementDraft, b: ManagementDraft): boolean {
  if (a.protocol !== b.protocol) return false;
  if (a.protocol === 'gnmi' && b.protocol === 'gnmi') {
    return a.operation === b.operation && a.dataType === b.dataType && JSON.stringify(a.paths) === JSON.stringify(b.paths);
  }
  if (a.protocol === 'netconf' && b.protocol === 'netconf') {
    return a.operation === b.operation && a.source === b.source && a.filter === b.filter;
  }
  return false;
}

function usePreviousRun(run: RunRecord): RunRecord | undefined {
  return useWorkbenchState((state) => {
    const index = state.runs.findIndex((candidate) => candidate.id === run.id);
    return state.runs
      .slice(index + 1)
      .find((candidate) => candidate.status === 'ok' && candidate.result?.op === run.result?.op && sameRequest(candidate.draft, run.draft));
  });
}

function ResultToolbar({ children }: { children: ReactNode }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{ alignItems: 'center', px: 1.5, py: 0.5, borderBottom: 1, borderColor: 'divider', minHeight: 38, flexWrap: 'wrap', flexShrink: 0 }}
    >
      {children}
    </Stack>
  );
}

function GnmiGetView({ run, notifications }: { run: RunRecord; notifications: GnmiNotification[] }) {
  const { store } = useWorkbench();
  const view = useWorkbenchState((state) => state.resultView);
  const registry = store.getState().explorer.registry;
  const root = useMemo(() => treeFromNotifications(notifications, registry), [notifications, registry]);
  const requested = (run.draft as GnmiDraft).paths;
  const tree = useTreeState(root, requested);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ node: DataNode; x: number; y: number } | null>(null);
  const [compare, setCompare] = useState(false);
  const previous = usePreviousRun(run);
  const leaves = useMemo(() => countLeaves(root), [root]);
  const raw = useMemo(() => (view === 'raw' ? JSON.stringify(notifications, null, 2) : ''), [view, notifications]);
  const previousRoot = useMemo(
    () =>
      compare && previous?.result?.op === 'gnmi-get'
        ? treeFromNotifications(previous.result.notifications, registry)
        : undefined,
    [compare, previous, registry],
  );

  return (
    <>
      <ResultToolbar>
        <ViewToggle
          value={view}
          onChange={(value) => store.getState().setResultView(value as 'tree' | 'table' | 'raw')}
          options={[
            { value: 'tree', label: 'Tree', icon: <AccountTreeOutlinedIcon sx={{ fontSize: 14 }} /> },
            { value: 'table', label: 'Table', icon: <TableRowsOutlinedIcon sx={{ fontSize: 14 }} /> },
            { value: 'raw', label: 'JSON', icon: <DataObjectOutlinedIcon sx={{ fontSize: 14 }} /> },
          ]}
        />
        <Typography variant="caption" color="textSecondary">
          {leaves} {leaves === 1 ? 'value' : 'values'} · {notifications.length} {notifications.length === 1 ? 'notification' : 'notifications'}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {view !== 'raw' && <FilterBox value={filter} onChange={setFilter} />}
        {view === 'tree' && (
          <>
            <Tooltip title="Expand all">
              <IconButton size="small" aria-label="Expand all" onClick={tree.expandAll}>
                <UnfoldMoreIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Collapse all">
              <IconButton size="small" aria-label="Collapse all" onClick={tree.collapseAll}>
                <UnfoldLessIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
        <Tooltip title={previous ? `Compare with the run at ${timeOf(previous.startedAt)}` : 'Run the same request again to compare'}>
          <span>
            <IconButton size="small" aria-label="Compare with the previous run" disabled={!previous} onClick={() => setCompare(true)}>
              <CompareArrowsIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Copy as JSON">
          <IconButton
            size="small"
            aria-label="Copy as JSON"
            onClick={() =>
              void copyToClipboard(JSON.stringify(nodeToJson(root), null, 2)).then((ok) =>
                showToast(ok ? 'success' : 'error', ok ? 'Copied the result as JSON.' : 'Could not copy.'),
              )
            }
          >
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Save as JSON">
          <IconButton
            size="small"
            aria-label="Save as JSON"
            onClick={() => saveTextFile(exportFilename(`gnmi ${run.summary}`, 'json'), JSON.stringify(notifications, null, 2), 'application/json')}
          >
            <FileDownloadOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </ResultToolbar>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {view === 'tree' && (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <DataTreeView
              root={root}
              expanded={tree.expanded}
              version={tree.version}
              onToggle={tree.toggle}
              filter={filter}
              ariaLabel="Result"
              onContextMenu={(node, event) => setMenu({ node, x: event.clientX, y: event.clientY })}
              renderRowActions={(node) => <NodeRowActions node={node} root={root} />}
              empty={
                <Typography variant="body2" color="textSecondary">
                  {filter ? 'Nothing matches the filter.' : 'The device returned no data for this path.'}
                </Typography>
              }
            />
          </Box>
        )}
        {view === 'table' && <LeafTable root={root} filter={filter} requested={requested} />}
        {view === 'raw' && (
          <Box sx={{ flex: 1, minWidth: 0, p: 1 }}>
            <CodeEditor value={raw} language="json" readOnly ariaLabel="Raw response" />
          </Box>
        )}
      </Box>
      <NodeMenu target={menu} root={root} onClose={() => setMenu(null)} />
      <ReviewDialog
        open={compare && !!previousRoot}
        title="Compare with the previous run"
        description={previous ? `Left: ${timeOf(previous.startedAt)}. Right: ${timeOf(run.startedAt)}.` : undefined}
        sections={
          previousRoot
            ? [{ label: run.summary, original: canonicalJson(nodeToJson(previousRoot)), modified: canonicalJson(nodeToJson(root)), language: 'json' }]
            : []
        }
        onClose={() => setCompare(false)}
      />
    </>
  );
}

const TABLE_ROW = 26;

function LeafTable({ root, filter, requested }: { root: DataNode; filter: string; requested: readonly string[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport({ top: element.scrollTop, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = collectLeaves(root);
    return needle
      ? all.filter((row) => row.path.toLowerCase().includes(needle) || valueText(row.value).toLowerCase().includes(needle))
      : all;
  }, [root, filter]);
  // Leave out the part of the path that was asked for when there was only one.
  const skip = requested.filter((path) => path.trim()).length === 1 ? Math.max(0, (tryParseGnmiPath(requested[0]!)?.elems.length ?? 1) - 1) : 0;
  const start = Math.max(0, Math.floor(viewport.top / TABLE_ROW) - 10);
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / TABLE_ROW) + 10);
  return (
    <Box
      ref={scrollRef}
      onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      sx={{ flex: 1, minWidth: 0, overflow: 'auto' }}
    >
      <Box sx={{ height: rows.length * TABLE_ROW, position: 'relative' }}>
        <Box sx={{ position: 'absolute', top: start * TABLE_ROW, left: 0, right: 0 }}>
          {rows.slice(start, end).map((row) => (
            <Stack
              key={row.path}
              direction="row"
              spacing={2}
              sx={{
                px: 1.5,
                height: TABLE_ROW,
                alignItems: 'center',
                fontSize: 12.5,
                borderBottom: 1,
                borderColor: 'divider',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.path}>
                <PathText path={row.path} skip={skip} sx={{ whiteSpace: 'nowrap', wordBreak: 'normal', overflowWrap: 'normal' }} />
              </Box>
              <Box
                title={valueText(row.value)}
                sx={{ width: '35%', fontFamily: MONO_FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: valueColorSx(row.value) }}
              >
                {valueText(row.value)}
              </Box>
            </Stack>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

// gNMI Set

function SetResultView({ run, result }: { run: RunRecord; result: Extract<ManagementResult, { op: 'gnmi-set' }> }) {
  const { store, controller } = useWorkbench();
  const draft = run.draft as GnmiDraft;
  const verify = () => {
    const paths = [...new Set(draft.set.filter((item) => item.op !== 'delete' && item.path.trim()).map((item) => item.path.trim()))];
    if (paths.length === 0) return;
    const next: GnmiDraft = { ...defaultGnmiDraft(), ...draft, operation: 'get', paths, dataType: 'config' };
    store.getState().replaceDraft(next);
    controller.run(next);
  };
  const timestamp = Number(BigInt(result.timestamp || '0') / 1_000_000n);
  return (
    <Box sx={{ p: 2, overflow: 'auto' }}>
      <Alert severity="success" variant="outlined" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
        <Stack spacing={1}>
          <Typography variant="body2" sx={{ fontWeight: 650 }}>
            The device applied {result.results.length} {result.results.length === 1 ? 'change' : 'changes'}
            {timestamp ? ` at ${timeOf(timestamp)}` : ''}.
          </Typography>
          <Stack spacing={0.25}>
            {result.results.map((item, index) => (
              <Stack key={index} direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
                <Chip size="small" label={item.op} sx={{ height: 18, fontSize: 10.5, minWidth: 56 }} />
                <PathText path={item.path} sx={{ fontSize: 12.5 }} />
              </Stack>
            ))}
          </Stack>
          {draft.set.some((item) => item.op !== 'delete') && (
            <Box>
              <Button size="small" startIcon={<PlayArrowRoundedIcon />} onClick={verify}>
                Get the configuration now
              </Button>
            </Box>
          )}
        </Stack>
      </Alert>
    </Box>
  );
}

// NETCONF

function RpcErrorCard({ error }: { error: RpcErrorInfo }) {
  return (
    <Alert severity={error.severity === 'warning' ? 'warning' : 'error'} variant="outlined" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
      <Stack spacing={0.75}>
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 650 }}>
            {error.message ?? error.tag ?? 'Error'}
          </Typography>
          {error.tag && <Chip size="small" label={error.tag} sx={{ height: 20, fontFamily: MONO_FONT, fontSize: 11 }} />}
          {error.type && <Chip size="small" variant="outlined" label={error.type} sx={{ height: 20, fontSize: 11 }} />}
        </Stack>
        {error.path && (
          <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 12 }}>
            at {error.path}
          </Typography>
        )}
        {error.info.length > 0 && (
          <Stack spacing={0.25}>
            {error.info.map((item) => (
              <Typography key={`${item.name}:${item.value}`} variant="caption" sx={{ fontFamily: MONO_FONT }}>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  {item.name}:
                </Box>{' '}
                {item.value}
              </Typography>
            ))}
          </Stack>
        )}
      </Stack>
    </Alert>
  );
}

function NetconfReplyView({ run, xml }: { run: RunRecord; xml: string }) {
  const { store } = useWorkbench();
  const view = useWorkbenchState((state) => state.resultView);
  const reply = useMemo(() => parseRpcReply(xml), [xml]);
  const draft = run.draft as NetconfDraft;
  const schema = draft.operation === 'get-schema' && reply?.data ? reply.data.textContent?.trim() ?? '' : undefined;
  const root = useMemo(() => {
    const tree = createRoot();
    if (reply?.data && draft.operation !== 'get-schema') mergeXml(tree, reply.data);
    return tree;
  }, [reply, draft.operation]);
  const tree = useTreeState(root, []);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ node: DataNode; x: number; y: number } | null>(null);
  const [compare, setCompare] = useState(false);
  const previous = usePreviousRun(run);
  const pretty = useMemo(() => (view === 'raw' || !reply?.data ? prettyXml(xml) : ''), [view, reply, xml]);
  const leaves = useMemo(() => countLeaves(root), [root]);
  const hasData = !!reply?.data && draft.operation !== 'get-schema';
  const dataXml = (source: string) => {
    const parsed = parseRpcReply(source);
    return parsed?.data ? prettyXml(new XMLSerializer().serializeToString(parsed.data)) : prettyXml(source);
  };

  if (schema !== undefined) {
    return (
      <>
        <ResultToolbar>
          <Typography variant="caption" color="textSecondary">
            YANG module {draft.schemaIdentifier} · {schema.split('\n').length} lines
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="Save as .yang">
            <IconButton
              size="small"
              aria-label="Save as YANG"
              onClick={() => saveTextFile(`${draft.schemaIdentifier || 'module'}.yang`, schema, 'text/plain')}
            >
              <FileDownloadOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </ResultToolbar>
        <Box sx={{ flex: 1, minHeight: 0, p: 1, display: 'flex' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <CodeEditor value={schema} language="yang" readOnly ariaLabel="YANG module" />
          </Box>
        </Box>
      </>
    );
  }

  return (
    <>
      <ResultToolbar>
        {hasData && (
          <ViewToggle
            value={view === 'table' ? 'tree' : view}
            onChange={(value) => store.getState().setResultView(value as 'tree' | 'raw')}
            options={[
              { value: 'tree', label: 'Tree', icon: <AccountTreeOutlinedIcon sx={{ fontSize: 14 }} /> },
              { value: 'raw', label: 'XML', icon: <DataObjectOutlinedIcon sx={{ fontSize: 14 }} /> },
            ]}
          />
        )}
        {hasData && (
          <Typography variant="caption" color="textSecondary">
            {leaves} {leaves === 1 ? 'value' : 'values'}
          </Typography>
        )}
        {!hasData && reply?.ok && (
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <CheckCircleRoundedIcon sx={{ fontSize: 16, color: 'success.main' }} />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              OK
            </Typography>
          </Stack>
        )}
        <Box sx={{ flex: 1 }} />
        {hasData && view !== 'raw' && <FilterBox value={filter} onChange={setFilter} />}
        {hasData && view !== 'raw' && (
          <>
            <Tooltip title="Expand all">
              <IconButton size="small" aria-label="Expand all" onClick={tree.expandAll}>
                <UnfoldMoreIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Collapse all">
              <IconButton size="small" aria-label="Collapse all" onClick={tree.collapseAll}>
                <UnfoldLessIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
        {hasData && (
          <Tooltip title={previous ? `Compare with the run at ${timeOf(previous.startedAt)}` : 'Run the same request again to compare'}>
            <span>
              <IconButton size="small" aria-label="Compare with the previous run" disabled={!previous} onClick={() => setCompare(true)}>
                <CompareArrowsIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title="Copy the reply">
          <IconButton
            size="small"
            aria-label="Copy the reply"
            onClick={() =>
              void copyToClipboard(prettyXml(xml)).then((ok) => showToast(ok ? 'success' : 'error', ok ? 'Copied the reply.' : 'Could not copy.'))
            }
          >
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Save as XML">
          <IconButton
            size="small"
            aria-label="Save as XML"
            onClick={() => saveTextFile(exportFilename(`netconf ${run.label}`, 'xml'), prettyXml(xml), 'application/xml')}
          >
            <FileDownloadOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </ResultToolbar>
      {reply && reply.errors.length > 0 && (
        <Stack spacing={1} sx={{ p: 1.5, pb: hasData ? 0 : 1.5, flexShrink: 0, maxHeight: '45%', overflow: 'auto' }}>
          {reply.errors.map((error, index) => (
            <RpcErrorCard key={index} error={error} />
          ))}
        </Stack>
      )}
      {!reply && (
        <Alert severity="warning" sx={{ m: 1.5 }}>
          The reply is not a well-formed rpc-reply; it is shown as received.
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {hasData && view !== 'raw' ? (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <DataTreeView
              root={root}
              expanded={tree.expanded}
              version={tree.version}
              onToggle={tree.toggle}
              filter={filter}
              ariaLabel="Reply data"
              onContextMenu={(node, event) => setMenu({ node, x: event.clientX, y: event.clientY })}
              renderRowActions={(node) => <NodeRowActions node={node} root={root} />}
              empty={
                <Typography variant="body2" color="textSecondary">
                  {filter ? 'Nothing matches the filter.' : 'The reply’s <data> is empty: nothing matched the filter.'}
                </Typography>
              }
            />
          </Box>
        ) : !hasData && reply?.ok && reply.errors.length === 0 && view !== 'raw' ? (
          <OkView draft={draft} />
        ) : hasData || !reply || (reply.errors.length === 0 && !reply.ok) || view === 'raw' ? (
          <Box sx={{ flex: 1, minWidth: 0, p: 1 }}>
            <CodeEditor value={pretty || prettyXml(xml)} language="xml" readOnly ariaLabel="Reply XML" />
          </Box>
        ) : null}
      </Box>
      <NodeMenu target={menu} root={root} onClose={() => setMenu(null)} />
      <ReviewDialog
        open={compare && previous?.result?.op === 'netconf-rpc'}
        title="Compare with the previous run"
        description={previous ? `Left: ${timeOf(previous.startedAt)}. Right: ${timeOf(run.startedAt)}.` : undefined}
        sections={
          previous?.result?.op === 'netconf-rpc'
            ? [{ label: run.label, original: dataXml(previous.result.xml), modified: dataXml(xml), language: 'xml' }]
            : []
        }
        onClose={() => setCompare(false)}
      />
    </>
  );
}

/** What an <ok/> means for the operation that got it, and what usually comes next. */
function okMessage(draft: NetconfDraft): { title: string; detail?: string } {
  switch (draft.operation) {
    case 'edit-config':
      return draft.target === 'candidate'
        ? { title: 'The candidate took the change.', detail: 'Nothing is live yet: review and commit it from the bar above.' }
        : { title: `The ${draft.target} configuration was changed.` };
    case 'commit':
      return draft.confirmed
        ? { title: 'Committed, pending confirmation.', detail: 'Confirm before the timer runs out, or the device rolls back.' }
        : { title: 'Committed.', detail: 'The candidate is now the running configuration.' };
    case 'discard-changes':
      return { title: 'The candidate was reset to the running configuration.' };
    case 'validate':
      return { title: `The ${draft.source} configuration is valid.` };
    case 'lock':
      return { title: `This session now holds the ${draft.target} lock.`, detail: 'Other sessions cannot change it until you unlock it or disconnect.' };
    case 'unlock':
      return { title: `The ${draft.target} lock was released.` };
    case 'cancel-commit':
      return { title: 'The confirmed commit was rolled back.' };
    case 'copy-config':
      return { title: `Copied ${draft.source} to ${draft.target}.` };
    case 'delete-config':
      return { title: `The ${draft.target} datastore was deleted.` };
    case 'kill-session':
      return { title: `Session ${draft.sessionId} was ended.` };
    case 'create-subscription':
      return { title: 'Subscribed to notifications.', detail: 'They appear as the device sends them.' };
    default:
      return { title: 'The device accepted the request.' };
  }
}

function OkView({ draft }: { draft: NetconfDraft }) {
  const candidate = useWorkbenchState((state) => state.candidate);
  const intoCandidate = draft.operation === 'edit-config' && draft.target === 'candidate';
  // Whether there is anything to commit depends on the candidate, not on this reply.
  const message =
    intoCandidate && candidate && !candidate.checking && !candidate.dirty
      ? { title: 'The candidate took the change.', detail: 'It already matches the running configuration: there is nothing to commit.' }
      : okMessage(draft);
  return (
    <Stack spacing={1} sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', textAlign: 'center', px: 3 }}>
      <CheckCircleRoundedIcon sx={{ fontSize: 40, color: 'success.main' }} />
      <Typography variant="subtitle1">{message.title}</Typography>
      {message.detail && (
        <Typography variant="body2" color="textSecondary" sx={{ maxWidth: 460 }}>
          {message.detail}
        </Typography>
      )}
    </Stack>
  );
}

// Empty state

interface QuickStart {
  label: string;
  detail: string;
  draft: ManagementDraft;
  icon: ReactNode;
}

function quickStarts(models: readonly string[], protocol: 'gnmi' | 'netconf'): QuickStart[] {
  if (protocol === 'netconf') {
    return [
      {
        label: 'Running configuration',
        detail: 'get-config from running',
        icon: <PlayArrowRoundedIcon fontSize="small" />,
        draft: { ...defaultNetconfDraft(), operation: 'get-config', source: 'running', filterType: 'none' },
      },
      {
        label: 'NETCONF sessions',
        detail: 'Who else is connected',
        icon: <PlayArrowRoundedIcon fontSize="small" />,
        draft: {
          ...defaultNetconfDraft(),
          operation: 'get',
          filterType: 'subtree',
          filter: '<netconf-state xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring">\n  <sessions/>\n</netconf-state>',
        },
      },
    ];
  }
  const has = (fragment: string) => models.some((model) => model.includes(fragment));
  const starts: QuickStart[] = [];
  const get = (paths: string[], extra: Partial<GnmiDraft> = {}): GnmiDraft => ({ ...defaultGnmiDraft(), paths, ...extra });
  const watch = (paths: string[], seconds = 2): GnmiDraft => ({
    ...defaultGnmiDraft(),
    operation: 'subscribe',
    paths,
    subscribe: { ...defaultGnmiDraft().subscribe, listMode: 'stream', mode: 'sample', sampleSeconds: seconds },
  });
  if (has('srl_nokia')) {
    starts.push(
      { label: 'System information', detail: '/system/information', icon: <PlayArrowRoundedIcon fontSize="small" />, draft: get(['/system/information']) },
      { label: 'Interface counters, live', detail: '/interface[name=*]/statistics', icon: <MonitorHeartOutlinedIcon fontSize="small" />, draft: watch(['/interface[name=*]/statistics']) },
      { label: 'Interfaces at a glance', detail: 'oper-state of every interface', icon: <PlayArrowRoundedIcon fontSize="small" />, draft: get(['/interface[name=*]/oper-state']) },
      { label: 'Routing tables', detail: '/network-instance, two levels', icon: <PlayArrowRoundedIcon fontSize="small" />, draft: get(['/network-instance'], { depth: 2 }) },
    );
  } else if (has('openconfig-interfaces')) {
    starts.push(
      { label: 'Interface counters, live', detail: '/interfaces/interface/state/counters', icon: <MonitorHeartOutlinedIcon fontSize="small" />, draft: watch(['/interfaces/interface[name=*]/state/counters'], 5) },
      { label: 'Interface state', detail: 'oper-status of every interface', icon: <PlayArrowRoundedIcon fontSize="small" />, draft: get(['/interfaces/interface[name=*]/state/oper-status']) },
      ...(has('openconfig-system')
        ? [{ label: 'System state', detail: '/system/state', icon: <PlayArrowRoundedIcon fontSize="small" />, draft: get(['/system/state']) }]
        : []),
    );
  }
  starts.push({ label: 'Top of the tree', detail: '/ with depth 2', icon: <PlayArrowRoundedIcon fontSize="small" />, draft: get(['/'], { depth: 2 }) });
  return starts;
}

function EmptyResult() {
  const { controller, store, connected, profile } = useWorkbench();
  const models = controller.gnmiInfo?.models.map((model) => model.name) ?? [];
  const starts = quickStarts(models, profile.kind);
  return (
    <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'safe center', p: 3, overflow: 'auto' }} spacing={2.5}>
      <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 520 }}>
        <Typography variant="subtitle1">Nothing run yet</Typography>
        <Typography variant="body2" color="textSecondary">
          {profile.kind === 'gnmi'
            ? 'Browse the device in the explorer, or type a path above — it completes from the device’s own data. '
            : 'Browse the configuration in the explorer, or pick an operation above. '}
          <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
            {HOTKEY_MOD_LABEL}Enter runs it.
          </Box>
        </Typography>
      </Stack>
      {connected && (
        <Stack spacing={0.75} sx={{ width: '100%', maxWidth: 460 }}>
          <Typography variant="caption" color="textSecondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Try
          </Typography>
          {starts.map((start) => (
            <Box
              key={start.label}
              component="button"
              type="button"
              onClick={() => {
                store.getState().replaceDraft(start.draft);
                controller.run(start.draft);
              }}
              sx={(theme) => ({
                all: 'unset',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.5,
                py: 1,
                borderRadius: 1.5,
                border: 1,
                borderColor: 'divider',
                bgcolor: 'background.paper',
                transition: 'border-color 120ms ease, background-color 120ms ease',
                '&:hover': { borderColor: 'primary.main', bgcolor: alpha(theme.palette.primary.main, 0.05) },
                '&:focus-visible': { outline: `2px solid ${alpha(theme.palette.primary.main, 0.5)}` },
              })}
            >
              <Box sx={{ color: 'primary.main', display: 'flex' }}>{start.icon}</Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {start.label}
                </Typography>
                <Typography variant="caption" color="textSecondary" sx={{ fontFamily: MONO_FONT, fontSize: 11 }}>
                  {start.detail}
                </Typography>
              </Box>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

