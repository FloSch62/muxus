import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import { useQueryClient } from '@tanstack/react-query';
import { listeningPortTarget, type ListeningPort } from '@muxus/shared';
import { fetchListeningPorts } from '../../api/environments.js';
import { useForwards } from '../../api/queries.js';
import { stopForward } from '../../api/tunnels.js';
import { copyToClipboard } from '../../clipboard.js';
import { environmentSource } from '../../environments.js';
import {
  forwardedPortUrl,
  forwardHostPort,
  localPortUrl,
  portScheme,
} from '../../environment-sessions.js';
import {
  forwardForPort,
  portCountLabel,
  portMatches,
  portPublishers,
  portReach,
  withPublishedPorts,
  type PortPublisher,
} from '../../listening-ports.js';
import { showErrorToast } from '../../state/toast.js';
import { unavailableWithSystemOpenSsh } from '../../system-openssh.js';
import type { SectionProps } from './EnvironmentSections.js';
import {
  LineAction,
  LineMenu,
  MONO,
  NoteLine,
  PortChip,
  StatusDot,
  TreeLine,
  type MenuEntry,
} from './EnvironmentTree.js';

type PortsState =
  | { status: 'loading' }
  | { status: 'ready'; ports: ListeningPort[]; connId?: string }
  | { status: 'error'; message: string };

function openInBrowser(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/**
 * The TCP ports a host listens on and the program behind each. A port of an
 * SSH host is forwarded to this computer with one click, and then opens in
 * the browser from its own line. The list is read when the section opens,
 * not with the rest of the host.
 */
export function PortsSection({ host, depth, filter, expansion }: Pick<SectionProps, 'host' | 'depth' | 'filter' | 'expansion'>) {
  const key = `${host.key}/ports`;
  const open = expansion.isOpen(key, false);
  const [state, setState] = useState<PortsState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  // The entry object changes with every reading; the effect follows its key.
  const hostRef = useRef(host);
  useEffect(() => {
    hostRef.current = host;
  });
  // Reading the same host again keeps its list on screen until the new one arrives.
  const shownFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let live = true;
    if (shownFor.current !== host.key) setState({ status: 'loading' });
    void (async () => {
      try {
        const source = await environmentSource(hostRef.current, true);
        if (!source) throw new Error(`${hostRef.current.label} is not connected`);
        const response = await fetchListeningPorts(source);
        if (!live) return;
        shownFor.current = host.key;
        setState(
          response.status === 'ok'
            ? { status: 'ready', ports: response.ports, ...(source.kind === 'ssh' ? { connId: source.connId } : {}) }
            : { status: 'error', message: response.message },
        );
      } catch (error) {
        if (live) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [open, host.key, generation]);

  // A port a container publishes is named after the container, not after the
  // engine's proxy that holds it on the host.
  const publishers = useMemo(() => portPublishers(host.environments), [host.environments]);
  const ports = state.status === 'ready' ? withPublishedPorts(state.ports, publishers) : [];
  const shown = ports.filter((port) => portMatches(port, filter, publishers.get(port.port)?.container));
  if (filter && state.status === 'ready' && shown.length === 0) return null;

  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(key, false)}
        icon={<LanOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />}
        title="Listening ports"
        status={
          !open ? undefined : state.status === 'loading' ? (
            <CircularProgress size={12} sx={{ display: 'block' }} />
          ) : state.status === 'ready' ? (
            portCountLabel(shown.length, ports.length)
          ) : (
            'failed'
          )
        }
        actions={
          open ? (
            <LineAction
              label="Read the ports again"
              Icon={RefreshOutlinedIcon}
              onClick={() => setGeneration((value) => value + 1)}
            />
          ) : null
        }
      />
      {open && state.status === 'error' ? (
        <NoteLine depth={depth + 1} tone="error">
          {state.message}
        </NoteLine>
      ) : null}
      {open && state.status === 'ready' && ports.length === 0 ? (
        <NoteLine depth={depth + 1}>Nothing listens on a TCP port.</NoteLine>
      ) : null}
      {open && state.status === 'ready'
        ? shown.map((port) => (
            <PortLine
              key={`${port.port}/${port.process ?? ''}`}
              host={host}
              depth={depth + 1}
              port={port}
              publisher={publishers.get(port.port)}
              connId={state.connId}
            />
          ))
        : null}
    </>
  );
}

function PortLine({
  host,
  depth,
  port,
  publisher,
  connId,
}: Pick<SectionProps, 'host' | 'depth'> & { port: ListeningPort; publisher?: PortPublisher; connId?: string }) {
  const queryClient = useQueryClient();
  const { data } = useForwards();
  const [busy, setBusy] = useState(false);
  const remote = !!host.profile;
  const target = listeningPortTarget(port);
  const scheme = portScheme(port.port);
  const forward = remote ? forwardForPort(data?.forwards ?? [], connId, port) : undefined;
  const refreshForwards = () => queryClient.invalidateQueries({ queryKey: ['forwards'] });

  /** The forward that carries this port, started now if there is none yet. */
  const forwarded = async (): Promise<number | undefined> => {
    if (forward) return forward.bindPort;
    setBusy(true);
    try {
      const started = await forwardHostPort(host, target, port.port);
      await refreshForwards();
      return started?.localPort;
    } finally {
      setBusy(false);
    }
  };

  const open = (as: 'http' | 'https' = scheme) => {
    if (!remote) {
      openInBrowser(localPortUrl(target, port.port, as));
      return;
    }
    if (forward) {
      openInBrowser(forwardedPortUrl(forward.bindPort, as));
      return;
    }
    // The window must open within the click, before the forward is up.
    const view = window.open('about:blank', '_blank');
    void forwarded().then((localPort) => {
      if (localPort === undefined) view?.close();
      else if (view) view.location.href = forwardedPortUrl(localPort, as);
      else openInBrowser(forwardedPortUrl(localPort, as));
    });
  };

  const stop = async () => {
    if (!forward) return;
    try {
      await stopForward(forward.id);
    } catch (error) {
      showErrorToast(error);
    }
    await refreshForwards();
  };

  const blocked = remote && host.systemOpenSsh === true;
  const service = publisher?.container ?? port.process;
  const local = forward ? `127.0.0.1:${forward.bindPort}` : undefined;
  const menu: MenuEntry[] = [
    { label: `Open as ${scheme}://`, onClick: () => open(scheme), disabled: blocked },
    {
      label: `Open as ${scheme === 'http' ? 'https' : 'http'}://`,
      onClick: () => open(scheme === 'http' ? 'https' : 'http'),
      disabled: blocked,
      divider: true,
    },
    ...(local
      ? [{ label: 'Copy forwarded address', onClick: () => void copyToClipboard(local) }]
      : []),
    { label: 'Copy port', onClick: () => void copyToClipboard(String(port.port)) },
  ];

  return (
    <TreeLine
      depth={depth}
      icon={<StatusDot health={forward ? 'up' : 'off'} />}
      title={<Box component="span" sx={MONO}>{port.port}</Box>}
      label={`Port ${port.port}${service ? `, ${service}` : ''}`}
      detail={service}
      status={
        forward ? (
          // A double click on the chip is two clicks on it, not the line's own action.
          <Box component="span" onDoubleClick={(event) => event.stopPropagation()}>
            <PortChip
              label={`localhost:${forward.bindPort}`}
              title={`Open ${forwardedPortUrl(forward.bindPort, scheme)}`}
              onClick={() => open()}
            />
          </Box>
        ) : (
          portReach(port)
        )
      }
      hint={[
        [
          'Container',
          publisher &&
            `${publisher.container}${publisher.containerPort === port.port ? '' : `, its port ${publisher.containerPort}`}`,
        ],
        ['Lab', publisher?.lab],
        ['Program', port.process],
        ['PID', port.pid],
        ['Listens on', port.addresses.join(', ')],
        ['Forwarded to', local],
      ]}
      onOpen={blocked ? undefined : () => open()}
      actions={
        <>
          {!remote ? (
            <LineAction label={`Open ${localPortUrl(target, port.port, scheme)}`} Icon={OpenInNewOutlinedIcon} onClick={() => open()} />
          ) : forward ? (
            <LineAction label="Stop forwarding" Icon={LinkOffOutlinedIcon} onClick={() => void stop()} />
          ) : (
            <LineAction
              label={blocked ? unavailableWithSystemOpenSsh('Forward to this computer') : 'Forward to this computer'}
              Icon={SwapHorizOutlinedIcon}
              disabled={blocked || busy}
              onClick={() => void forwarded()}
            />
          )}
          <LineMenu label={`More actions for port ${port.port}`} entries={menu} />
        </>
      }
    />
  );
}
