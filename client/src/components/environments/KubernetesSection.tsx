import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import SubjectOutlinedIcon from '@mui/icons-material/SubjectOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import {
  environmentCommandLine,
  type KubernetesEnvironment,
  type KubernetesPod,
} from '@muxus/shared';
import { fetchKubernetesNamespaces, fetchKubernetesPods } from '../../api/environments.js';
import { copyToClipboard } from '../../clipboard.js';
import { environmentSource, podWorkload } from '../../environments.js';
import {
  kubusAvailable,
  kubusPodRoute,
  openEnvironmentTarget,
  openInKubus,
} from '../../environment-sessions.js';
import type { HostEnvironmentsEntry } from '../../state/environments.js';
import { ENVIRONMENT_KINDS, EnvironmentLogo } from './environment-icons.js';
import type { SectionProps } from './EnvironmentSections.js';
import { LineAction, LineMenu, MONO, NoteLine, StatusDot, TreeLine, type Health } from './EnvironmentTree.js';

const ALL_NAMESPACES = '';

function podHealth(pod: KubernetesPod): Health {
  if (pod.phase === 'Succeeded') return 'off';
  if (pod.phase === 'Failed' || /Error|BackOff|Crash|Evicted|OOM/i.test(pod.reason ?? '')) return 'down';
  const [ready, total] = pod.ready.split('/').map(Number);
  if (pod.phase === 'Running' && ready === total) return 'up';
  return 'warn';
}

/**
 * Kubeconfig contexts on the host, and for an opened one the pods of a
 * namespace grouped by workload. Pods are read when a context opens, not with
 * the rest of the host: a cluster can be slow or far away.
 */
export function KubernetesSection({ environment, ...props }: SectionProps & { environment: KubernetesEnvironment }) {
  const { host, depth, expansion } = props;
  const kind = ENVIRONMENT_KINDS.kubernetes;
  const key = `${host.key}/kubernetes`;
  const open = expansion.isOpen(key, true);
  const [kubus, setKubus] = useState(false);
  useEffect(() => {
    // Kubus reads this computer's kubeconfig: a remote host's contexts are not there.
    if (host.profile) return;
    let live = true;
    void kubusAvailable().then((available) => {
      if (live) setKubus(available);
    });
    return () => {
      live = false;
    };
  }, [host.profile]);

  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(key, true)}
        icon={<EnvironmentLogo kind="kubernetes" />}
        title={kind.label}
        detail={environment.version ? `kubectl ${environment.version}` : undefined}
        status={`${environment.contexts.length} context${environment.contexts.length === 1 ? '' : 's'}`}
        actions={
          kubus ? <LineAction label="Open Kubus" Icon={OpenInNewOutlinedIcon} onClick={() => openInKubus('/')} /> : null
        }
      />
      {open
        ? environment.contexts.map((context) => (
            <ContextLines
              key={context}
              {...props}
              depth={depth + 1}
              context={context}
              current={context === environment.currentContext}
              kubus={kubus}
            />
          ))
        : null}
    </>
  );
}

type PodsState =
  | { status: 'loading' }
  | { status: 'ready'; pods: KubernetesPod[] }
  | { status: 'error'; message: string };

function ContextLines({
  context,
  current,
  kubus,
  ...props
}: SectionProps & { context: string; current: boolean; kubus: boolean }) {
  const { host, depth, filter, showStopped, expansion } = props;
  const key = `${host.key}/kubernetes/${context}`;
  // Only the current context opens by itself; the others may be far-away clusters.
  const open = expansion.isOpen(key, current);
  const [namespace, setNamespace] = useState('default');
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [pods, setPods] = useState<PodsState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  // The entry object changes with every reading; the effects follow its key.
  const hostRef = useRef(host);
  useEffect(() => {
    hostRef.current = host;
  });

  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const source = await environmentSource(hostRef.current, true).catch(() => undefined);
      if (!source || !live) return;
      try {
        const { namespaces: names } = await fetchKubernetesNamespaces(source, context);
        if (live) setNamespaces(names);
      } catch {
        // Listing namespaces may be forbidden; a namespace can still be read.
      }
    })();
    return () => {
      live = false;
    };
  }, [open, host.key, context]);

  // What the shown list is of. Reading the same list again (a refresh) keeps it
  // on screen until the new one arrives; another context or namespace starts over.
  const shownFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const listKey = `${host.key}\n${context}\n${namespace}`;
    const again = shownFor.current === listKey;
    if (!again) {
      shownFor.current = undefined;
      setPods({ status: 'loading' });
    }
    void (async () => {
      try {
        const source = await environmentSource(hostRef.current, true);
        if (!source) throw new Error(`${hostRef.current.label} is not connected`);
        const { pods: list } = await fetchKubernetesPods(source, context, namespace || undefined);
        if (!live) return;
        shownFor.current = listKey;
        setPods({ status: 'ready', pods: list });
      } catch (error) {
        if (!live) return;
        shownFor.current = undefined;
        setPods({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [open, host.key, context, namespace, generation, host.sampledAt]);

  const choices = [...new Set([ALL_NAMESPACES, 'default', ...namespaces, namespace])];
  const visible =
    pods.status === 'ready'
      ? pods.pods.filter(
          (pod) =>
            (!filter || pod.name.includes(filter) || pod.namespace.includes(filter)) &&
            (showStopped || pod.phase !== 'Succeeded'),
        )
      : [];
  const groups = new Map<string, { label: string; pods: KubernetesPod[] }>();
  for (const pod of visible) {
    const workload = podWorkload(pod);
    const id = workload ? `${pod.namespace}/${workload.kind}/${workload.name}` : `${pod.namespace}//`;
    const group = groups.get(id) ?? {
      label: workload ? `${workload.name}` : 'Standalone pods',
      pods: [],
    };
    group.pods.push(pod);
    groups.set(id, group);
  }

  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(key, current)}
        icon={<StatusDot health={current ? 'up' : 'off'} />}
        title={context}
        detail={current ? 'current' : undefined}
        emphasis={current}
        status={
          open ? (
            <Select
              size="small"
              variant="standard"
              disableUnderline
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              renderValue={(value) => (value === ALL_NAMESPACES ? 'All namespaces' : value)}
              inputProps={{ 'aria-label': `Namespace in ${context}` }}
              sx={{ fontSize: 11, '& .MuiSelect-select': { py: 0, pr: '20px !important' } }}
            >
              {choices.map((choice) => (
                <MenuItem key={choice || 'all'} value={choice} dense>
                  {choice === ALL_NAMESPACES ? 'All namespaces' : choice}
                </MenuItem>
              ))}
            </Select>
          ) : undefined
        }
        actions={
          <>
            {open ? (
              <LineAction label="Read the pods again" Icon={RefreshOutlinedIcon} onClick={() => setGeneration((n) => n + 1)} />
            ) : null}
            {kubus ? (
              <LineAction label="Open in Kubus" Icon={OpenInNewOutlinedIcon} onClick={() => openInKubus('/')} />
            ) : null}
          </>
        }
      />
      {open && pods.status === 'loading' ? (
        <Box sx={{ pl: `${8 + (depth + 1) * 16 + 22}px`, py: 0.75 }}>
          <CircularProgress size={14} />
        </Box>
      ) : null}
      {open && pods.status === 'error' ? (
        <NoteLine depth={depth + 1} tone="error">
          {pods.message}
        </NoteLine>
      ) : null}
      {open && pods.status === 'ready' && visible.length === 0 ? (
        <NoteLine depth={depth + 1}>No pods{namespace ? ` in ${namespace}` : ''}.</NoteLine>
      ) : null}
      {open
        ? [...groups.entries()].map(([id, group]) => (
            <WorkloadLines
              key={id}
              {...props}
              depth={depth + 1}
              id={`${key}/${id}`}
              label={group.label}
              pods={group.pods}
              context={context}
              kubus={kubus}
              showNamespace={!namespace}
            />
          ))
        : null}
    </>
  );
}

function WorkloadLines({
  id,
  label,
  pods,
  context,
  kubus,
  showNamespace,
  ...props
}: SectionProps & {
  id: string;
  label: string;
  pods: KubernetesPod[];
  context: string;
  kubus: boolean;
  showNamespace: boolean;
}) {
  const { host, depth, expansion } = props;
  const open = expansion.isOpen(id, true);
  const ready = pods.filter((pod) => podHealth(pod) === 'up').length;
  const workload = pods[0] ? podWorkload(pods[0]) : undefined;
  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(id, true)}
        title={label}
        detail={`${workload?.kind ?? ''}${showNamespace && pods[0] ? ` · ${pods[0].namespace}` : ''}`}
        status={`${ready} / ${pods.length} ready`}
      />
      {open ? pods.map((pod) => <PodLine key={`${pod.namespace}/${pod.name}`} host={host} depth={depth + 1} pod={pod} context={context} kubus={kubus} />) : null}
    </>
  );
}

function PodLine({
  host,
  depth,
  pod,
  context,
  kubus,
}: {
  host: HostEnvironmentsEntry;
  depth: number;
  pod: KubernetesPod;
  context: string;
  kubus: boolean;
}) {
  const health = podHealth(pod);
  const running = pod.phase === 'Running';
  const target = { context, namespace: pod.namespace, pod: pod.name };
  const shell = (container?: string) =>
    openEnvironmentTarget(host, { kind: 'pod', ...target, ...(container ? { container } : {}) });
  const logs = (previous = false, container?: string) =>
    openEnvironmentTarget(host, {
      kind: 'pod-logs',
      ...target,
      ...(container ? { container } : {}),
      ...(previous ? { previous } : {}),
    });
  const several = pod.containers.length > 1;
  return (
    <>
      <TreeLine
        depth={depth}
        icon={<StatusDot health={health} />}
        title={<Box component="span" sx={{ ...MONO, fontSize: 12 }}>{pod.name}</Box>}
        label={pod.name}
        detail={pod.restarts > 0 ? `${pod.restarts} restart${pod.restarts === 1 ? '' : 's'}` : undefined}
        status={pod.ready}
        hint={[
          ['Namespace', pod.namespace],
          ['Phase', pod.reason ? `${pod.phase} (${pod.reason})` : pod.phase],
          ['Ready', pod.ready],
          ['Restarts', pod.restarts],
          ['Node', pod.node],
          ['Owner', pod.owner ? `${pod.owner.kind}/${pod.owner.name}` : undefined],
          ['Containers', pod.containers.join(', ')],
          ['Created', pod.createdAt],
        ]}
        dim={health === 'off'}
        onOpen={running ? () => shell() : () => logs()}
        actions={
          <>
            {running ? <LineAction label="Open shell" Icon={TerminalOutlinedIcon} onClick={() => shell()} /> : null}
            <LineAction label="Follow logs" Icon={SubjectOutlinedIcon} onClick={() => logs()} />
            <LineMenu
              label={`More actions for ${pod.name}`}
              entries={[
                ...(several && running
                  ? pod.containers.map((container) => ({
                      label: `Shell in ${container}`,
                      onClick: () => shell(container),
                    }))
                  : []),
                ...(several
                  ? pod.containers.map((container) => ({
                      label: `Logs of ${container}`,
                      onClick: () => logs(false, container),
                    }))
                  : []),
                { label: 'Logs of the previous run', onClick: () => logs(true), divider: !kubus },
                ...(kubus
                  ? [
                      {
                        label: 'Open in Kubus',
                        divider: true,
                        onClick: () => openInKubus(kubusPodRoute(context, pod.namespace, pod.name)),
                      },
                    ]
                  : []),
                {
                  label: 'Copy exec command',
                  onClick: () => void copyToClipboard(environmentCommandLine({ kind: 'pod', ...target })),
                },
              ]}
            />
          </>
        }
      />
      {pod.reason ? (
        <NoteLine depth={depth} tone={health === 'down' ? 'error' : 'warning'}>
          {pod.reason}
        </NoteLine>
      ) : null}
    </>
  );
}
