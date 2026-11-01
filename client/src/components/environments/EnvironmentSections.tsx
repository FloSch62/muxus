import Box from '@mui/material/Box';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import ScreenShareOutlinedIcon from '@mui/icons-material/ScreenShareOutlined';
import SubjectOutlinedIcon from '@mui/icons-material/SubjectOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import {
  environmentCommandLine,
  type ContainerInfo,
  type ContainerlabEnvironment,
  type ContainerlabLab,
  type ContainerRuntimeEnvironment,
  type EnvironmentAction,
  type LibvirtDomain,
  type LibvirtEnvironment,
  type ProxmoxEnvironment,
  type ProxmoxGuest,
} from '@muxus/shared';
import {
  fetchLibvirtAddresses,
  fetchLibvirtDisplay,
  fetchProxmoxAddresses,
  type EnvironmentSource,
} from '../../api/environments.js';
import { copyToClipboard } from '../../clipboard.js';
import { environmentSource, isRunning, plainContainers } from '../../environments.js';
import {
  containerlabNodeEntry,
  nodeUsesSsh,
  openContainerlabNode,
  openEnvironmentTarget,
  openHostPort,
  openSessionGrid,
  openSshToAddress,
  openVncOnHost,
  portScheme,
} from '../../environment-sessions.js';
import type { HostEnvironmentsEntry } from '../../state/environments.js';
import { showToast } from '../../state/toast.js';
import { ENVIRONMENT_KINDS } from './environment-icons.js';
import {
  ChipRow,
  LineAction,
  LineMenu,
  MONO,
  NoteLine,
  PortChip,
  StatusDot,
  TreeLine,
  type Expansion,
  type Health,
  type MenuEntry,
} from './EnvironmentTree.js';

export interface SectionProps {
  host: HostEnvironmentsEntry;
  depth: number;
  /** Lower-cased search text; empty shows everything. */
  filter: string;
  showStopped: boolean;
  expansion: Expansion;
  /** Run a lifecycle action, asking first when `confirm` says so, then read the host again. */
  act: (action: EnvironmentAction, confirm?: { title: string; description: string }) => void;
}

function matches(filter: string, ...values: Array<string | undefined>): boolean {
  return !filter || values.some((value) => value?.toLowerCase().includes(filter));
}

function bytes(value: number | undefined): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

async function withSource<T>(
  host: HostEnvironmentsEntry,
  work: (source: EnvironmentSource) => Promise<T>,
): Promise<T | undefined> {
  try {
    const source = await environmentSource(host, true);
    if (!source) throw new Error(`${host.label} is not connected`);
    return await work(source);
  } catch (error) {
    showToast('error', error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function HiddenNote({ depth, hidden, noun }: { depth: number; hidden: number; noun: string }) {
  if (hidden === 0) return null;
  return (
    <NoteLine depth={depth}>
      {hidden} stopped {noun}
      {hidden === 1 ? '' : 's'} hidden
    </NoteLine>
  );
}

// ---------------------------------------------------------------------------
// Docker and Podman
// ---------------------------------------------------------------------------

function containerHealth(container: ContainerInfo): Health {
  if (isRunning(container.state)) return 'up';
  if (container.state === 'restarting' || container.state === 'paused' || container.state === 'created') {
    return 'warn';
  }
  if (container.state === 'dead' || /^exited \((?!0\))/i.test(container.status)) return 'down';
  return 'off';
}

export function ContainersSection({
  environment,
  ...props
}: SectionProps & { environment: ContainerRuntimeEnvironment }) {
  const { host, depth, filter, showStopped, expansion } = props;
  const kind = ENVIRONMENT_KINDS[environment.runtime];
  const all = plainContainers(environment.containers);
  const running = all.filter((container) => isRunning(container.state)).length;
  const matching = all.filter((container) =>
    matches(filter, container.name, container.image, container.composeProject),
  );
  const visible = matching.filter((container) => showStopped || isRunning(container.state));
  const key = `${host.key}/${environment.runtime}`;
  const open = expansion.isOpen(key, true);

  const projects = new Map<string, ContainerInfo[]>();
  const standalone: ContainerInfo[] = [];
  for (const container of visible) {
    if (container.composeProject) {
      const group = projects.get(container.composeProject) ?? [];
      group.push(container);
      projects.set(container.composeProject, group);
    } else standalone.push(container);
  }
  if (filter && visible.length === 0) return null;

  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(key, true)}
        icon={<kind.Icon sx={{ fontSize: 17, color: kind.color }} />}
        title={kind.label}
        detail={environment.version ? `v${environment.version}` : undefined}
        status={`${running} / ${all.length} running`}
      />
      {open ? (
        <>
          {[...projects.entries()].map(([project, containers]) => (
            <ComposeGroup
              key={project}
              {...props}
              depth={depth + 1}
              environment={environment}
              project={project}
              containers={containers}
            />
          ))}
          {standalone.map((container) => (
            <ContainerLine key={container.id} {...props} depth={depth + 1} environment={environment} container={container} />
          ))}
          {all.length === 0 ? <NoteLine depth={depth + 1}>No containers.</NoteLine> : null}
          <HiddenNote depth={depth + 1} hidden={matching.length - visible.length} noun="container" />
        </>
      ) : null}
    </>
  );
}

function ComposeGroup({
  environment,
  project,
  containers,
  ...props
}: SectionProps & { environment: ContainerRuntimeEnvironment; project: string; containers: ContainerInfo[] }) {
  const { host, depth, expansion, act } = props;
  const key = `${host.key}/${environment.runtime}/compose/${project}`;
  const open = expansion.isOpen(key, true);
  const running = containers.filter((container) => isRunning(container.state)).length;
  const compose = (action: 'start' | 'stop' | 'restart') =>
    act(
      { kind: 'compose', runtime: environment.runtime, project, action },
      action === 'stop'
        ? { title: `Stop ${project}?`, description: `Every container of the Compose project stops.` }
        : undefined,
    );
  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(key, true)}
        icon={<LayersOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />}
        title={project}
        detail="Compose"
        status={`${running} running`}
        actions={
          <LineMenu
            label={`More actions for ${project}`}
            entries={[
              { label: 'Start project', onClick: () => compose('start') },
              { label: 'Restart project', onClick: () => compose('restart') },
              { label: 'Stop project…', onClick: () => compose('stop'), destructive: true },
            ]}
          />
        }
      />
      {open
        ? containers.map((container) => (
            <ContainerLine key={container.id} {...props} depth={depth + 1} environment={environment} container={container} />
          ))
        : null}
    </>
  );
}

function ContainerLine({
  environment,
  container,
  ...props
}: SectionProps & { environment: ContainerRuntimeEnvironment; container: ContainerInfo }) {
  const { host, depth, act } = props;
  const { runtime } = environment;
  const up = isRunning(container.state);
  const shell = (shellName?: 'bash' | 'sh') =>
    openEnvironmentTarget(host, {
      kind: 'container',
      runtime,
      container: container.name,
      ...(shellName ? { shell: shellName } : {}),
    });
  const logs = () => openEnvironmentTarget(host, { kind: 'container-logs', runtime, container: container.name });
  const lifecycle = (action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause') =>
    act(
      { kind: 'container', runtime, container: container.name, action },
      action === 'stop'
        ? { title: `Stop ${container.name}?`, description: 'Its processes are asked to exit.' }
        : undefined,
    );
  const published = container.ports.filter((port) => port.hostPort && port.protocol === 'tcp');
  const menu: MenuEntry[] = [
    ...(up
      ? [
          { label: 'Shell (bash)', onClick: () => shell('bash') },
          { label: 'Shell (sh)', onClick: () => shell('sh'), divider: true },
        ]
      : []),
    ...(up
      ? [
          { label: 'Restart', onClick: () => lifecycle('restart') },
          container.state === 'paused'
            ? { label: 'Resume', onClick: () => lifecycle('unpause') }
            : { label: 'Pause', onClick: () => lifecycle('pause') },
          { label: 'Stop…', onClick: () => lifecycle('stop'), destructive: true, divider: true },
        ]
      : [{ label: 'Start', onClick: () => lifecycle('start'), divider: true }]),
    {
      label: 'Copy exec command',
      onClick: () =>
        void copyToClipboard(
          environmentCommandLine({ kind: 'container', runtime, container: container.name }),
        ),
    },
  ];

  return (
    <>
      <TreeLine
        depth={depth}
        icon={<StatusDot health={containerHealth(container)} />}
        title={container.name}
        detail={<Box component="span" sx={MONO}>{container.image}</Box>}
        status={container.status}
        dim={!up}
        onOpen={up ? () => shell() : logs}
        actions={
          <>
            {up ? <LineAction label="Open shell" Icon={TerminalOutlinedIcon} onClick={() => shell()} /> : null}
            {!up ? <LineAction label="Start" Icon={PlayArrowOutlinedIcon} onClick={() => lifecycle('start')} /> : null}
            <LineAction label="Follow logs" Icon={SubjectOutlinedIcon} onClick={logs} />
            <LineMenu label={`More actions for ${container.name}`} entries={menu} />
          </>
        }
      />
      {up && published.length > 0 ? (
        <ChipRow depth={depth}>
          {published.map((port) => (
            <PortChip
              key={`${port.hostPort}:${port.containerPort}`}
              label={`${port.hostPort} → ${port.containerPort}`}
              title={`Open ${portScheme(port.hostPort!)}://…:${port.hostPort}${host.profile ? `, forwarded from ${host.label}` : ''}`}
              onClick={() => void openHostPort(host, port.hostIp, port.hostPort!)}
            />
          ))}
        </ChipRow>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Containerlab
// ---------------------------------------------------------------------------

export function ContainerlabSection({
  environment,
  onTopology,
  ...props
}: SectionProps & { environment: ContainerlabEnvironment; onTopology: (lab: ContainerlabLab) => void }) {
  const { host, depth, filter, expansion } = props;
  const kind = ENVIRONMENT_KINDS.containerlab;
  const key = `${host.key}/containerlab`;
  const open = expansion.isOpen(key, true);
  const labs = environment.labs.filter(
    (lab) => matches(filter, lab.name) || lab.nodes.some((node) => matches(filter, node.name, node.kind, node.ipv4)),
  );
  if (filter && labs.length === 0) return null;
  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(key, true)}
        icon={<kind.Icon sx={{ fontSize: 17, color: kind.color }} />}
        title={kind.label}
        status={`${environment.labs.length} lab${environment.labs.length === 1 ? '' : 's'}`}
      />
      {open
        ? labs.map((lab) => (
            <LabLines key={lab.name} {...props} depth={depth + 1} lab={lab} onTopology={onTopology} />
          ))
        : null}
    </>
  );
}

function LabLines({
  lab,
  onTopology,
  ...props
}: SectionProps & { lab: ContainerlabLab; onTopology: (lab: ContainerlabLab) => void }) {
  const { host, depth, filter, showStopped, expansion } = props;
  const key = `${host.key}/containerlab/${lab.name}`;
  const open = expansion.isOpen(key, true);
  const running = lab.nodes.filter((node) => isRunning(node.state));
  const labMatches = matches(filter, lab.name);
  const matching = lab.nodes.filter((node) => labMatches || matches(filter, node.name, node.kind, node.ipv4));
  const nodes = matching.filter((node) => showStopped || isRunning(node.state));
  const file = lab.topologyFile?.split('/').pop();
  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(key, true)}
        icon={<StatusDot health={running.length === lab.nodes.length ? 'up' : running.length > 0 ? 'warn' : 'off'} />}
        title={lab.name}
        detail={file}
        status={`${running.length} / ${lab.nodes.length} nodes`}
        emphasis
        actions={
          <>
            <LineAction
              label="Show topology"
              Icon={HubOutlinedIcon}
              disabled={!lab.topologyFile}
              onClick={() => onTopology(lab)}
            />
            <LineAction
              label="Open all nodes side by side, typing into all of them"
              Icon={GridViewOutlinedIcon}
              disabled={running.length === 0}
              onClick={() =>
                void openSessionGrid(
                  lab.name,
                  running.map((node) => containerlabNodeEntry(host, lab, node)),
                  { multiExec: true },
                )
              }
            />
          </>
        }
      />
      {open
        ? nodes.map((node) => {
            const up = isRunning(node.state);
            const ssh = nodeUsesSsh(node);
            return (
              <TreeLine
                key={node.container}
                depth={depth + 1}
                icon={<StatusDot health={up ? 'up' : 'off'} />}
                title={node.name}
                detail={node.kind}
                status={node.ipv4 ? <Box component="span" sx={MONO}>{node.ipv4}</Box> : node.state}
                dim={!up}
                onOpen={up ? () => openContainerlabNode(host, lab, node) : undefined}
                actions={
                  <>
                    <LineAction
                      label={ssh ? `SSH to ${node.ipv4} as admin` : 'Open shell'}
                      Icon={ssh ? LoginOutlinedIcon : TerminalOutlinedIcon}
                      disabled={!up}
                      onClick={() => openContainerlabNode(host, lab, node)}
                    />
                    <LineMenu
                      label={`More actions for ${node.name}`}
                      entries={[
                        {
                          label: 'Shell in the container',
                          disabled: !up,
                          onClick: () =>
                            void openEnvironmentTarget(host, {
                              kind: 'container',
                              runtime: lab.runtime,
                              container: node.container,
                            }),
                        },
                        ...(node.ipv4
                          ? [
                              {
                                label: 'SSH as…',
                                disabled: !up,
                                onClick: () => void openSshToAddress(host, node.ipv4!, node.name),
                              },
                            ]
                          : []),
                        {
                          label: 'Follow container logs',
                          divider: true,
                          onClick: () =>
                            void openEnvironmentTarget(host, {
                              kind: 'container-logs',
                              runtime: lab.runtime,
                              container: node.container,
                            }),
                        },
                        ...(node.ipv4
                          ? [{ label: 'Copy management address', onClick: () => void copyToClipboard(node.ipv4!) }]
                          : []),
                      ]}
                    />
                  </>
                }
              />
            );
          })
        : null}
      {open ? <HiddenNote depth={depth + 1} hidden={matching.length - nodes.length} noun="node" /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Proxmox VE
// ---------------------------------------------------------------------------

async function sshToGuest(host: HostEnvironmentsEntry, guest: ProxmoxGuest): Promise<void> {
  const result = await withSource(host, (source) => fetchProxmoxAddresses(source, guest.type, guest.vmid));
  if (!result) return;
  const address = result.addresses[0];
  if (!address) {
    showToast('warning', `${guest.name} reports no address.`);
    return;
  }
  await openSshToAddress(host, address, guest.name);
}

export function ProxmoxSection({ environment, ...props }: SectionProps & { environment: ProxmoxEnvironment }) {
  const { host, depth, filter, showStopped, expansion, act } = props;
  const kind = ENVIRONMENT_KINDS.proxmox;
  const key = `${host.key}/proxmox`;
  const open = expansion.isOpen(key, true);
  const guests = environment.guests.filter((guest) => matches(filter, guest.name, String(guest.vmid)));
  const visible = guests.filter((guest) => showStopped || (guest.status === 'running' && !guest.template));
  const running = environment.guests.filter((guest) => guest.status === 'running').length;
  if (filter && guests.length === 0) return null;

  const power = (guest: ProxmoxGuest, action: 'start' | 'shutdown' | 'reboot' | 'stop') =>
    act(
      { kind: 'proxmox', type: guest.type, vmid: guest.vmid, action },
      action === 'stop'
        ? { title: `Stop ${guest.name}?`, description: 'The guest is switched off without shutting down.' }
        : action === 'shutdown'
          ? { title: `Shut down ${guest.name}?`, description: 'The guest is asked to shut down.' }
          : undefined,
    );

  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(key, true)}
        icon={<kind.Icon sx={{ fontSize: 17, color: kind.color }} />}
        title={kind.label}
        detail={environment.version}
        status={`${running} / ${environment.guests.length} running`}
        actions={
          <LineAction
            label="Open the web interface (https :8006)"
            Icon={PublicOutlinedIcon}
            onClick={() => void openHostPort(host, '127.0.0.1', 8006, 'https')}
          />
        }
      />
      {open
        ? visible.map((guest) => {
            const up = guest.status === 'running';
            const console = () =>
              openEnvironmentTarget(
                host,
                guest.type === 'lxc'
                  ? { kind: 'proxmox-lxc', vmid: guest.vmid }
                  : { kind: 'proxmox-serial', vmid: guest.vmid },
              );
            const load =
              up && guest.maxcpu
                ? `CPU ${Math.round(((guest.cpu ?? 0) * 100))}% · ${bytes(guest.mem)} / ${bytes(guest.maxmem)}`
                : guest.template
                  ? 'template'
                  : guest.status;
            return (
              <TreeLine
                key={guest.vmid}
                depth={depth + 1}
                icon={<StatusDot health={up ? 'up' : guest.status === 'paused' ? 'warn' : 'off'} />}
                title={guest.name}
                detail={`${guest.type === 'qemu' ? 'VM' : 'CT'} ${guest.vmid}${guest.node ? ` · ${guest.node}` : ''}`}
                status={load}
                dim={!up}
                onOpen={up ? console : undefined}
                actions={
                  <>
                    {up ? (
                      <LineAction
                        label={guest.type === 'lxc' ? 'Enter the container (pct enter)' : 'Serial console (qm terminal)'}
                        Icon={TerminalOutlinedIcon}
                        onClick={console}
                      />
                    ) : null}
                    {up ? (
                      <LineAction label="SSH to the guest" Icon={LoginOutlinedIcon} onClick={() => void sshToGuest(host, guest)} />
                    ) : null}
                    {!up && !guest.template ? (
                      <LineAction label="Start" Icon={PlayArrowOutlinedIcon} onClick={() => power(guest, 'start')} />
                    ) : null}
                    <LineMenu
                      label={`More actions for ${guest.name}`}
                      entries={
                        up
                          ? [
                              { label: 'Reboot', onClick: () => power(guest, 'reboot') },
                              { label: 'Shut down…', onClick: () => power(guest, 'shutdown') },
                              { label: 'Stop (force)…', onClick: () => power(guest, 'stop'), destructive: true },
                            ]
                          : guest.template
                            ? []
                            : [{ label: 'Start', onClick: () => power(guest, 'start') }]
                      }
                    />
                  </>
                }
              />
            );
          })
        : null}
      {open ? <HiddenNote depth={depth + 1} hidden={guests.length - visible.length} noun="guest" /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// libvirt
// ---------------------------------------------------------------------------

export function LibvirtSection({ environment, ...props }: SectionProps & { environment: LibvirtEnvironment }) {
  const { host, depth, filter, showStopped, expansion, act } = props;
  const kind = ENVIRONMENT_KINDS.libvirt;
  const key = `${host.key}/libvirt/${environment.uri ?? 'default'}`;
  const open = expansion.isOpen(key, true);
  const domains = environment.domains.filter((domain) => matches(filter, domain.name));
  const visible = domains.filter((domain) => showStopped || domain.state === 'running');
  const running = environment.domains.filter((domain) => domain.state === 'running').length;
  if (filter && domains.length === 0) return null;
  const { uri } = environment;

  const power = (domain: LibvirtDomain, action: 'start' | 'shutdown' | 'reboot' | 'destroy') =>
    act(
      { kind: 'libvirt', uri, domain: domain.name, action },
      action === 'destroy'
        ? { title: `Force off ${domain.name}?`, description: 'The VM is switched off without shutting down.' }
        : action === 'shutdown'
          ? { title: `Shut down ${domain.name}?`, description: 'The VM is asked to shut down.' }
          : undefined,
    );
  const vnc = async (domain: LibvirtDomain) => {
    const result = await withSource(host, (source) => fetchLibvirtDisplay(source, uri, domain.name));
    if (!result) return;
    if (!result.vnc) {
      showToast('warning', `${domain.name} has no VNC display.`);
      return;
    }
    openVncOnHost(host, result.vnc, domain.name);
  };
  const ssh = async (domain: LibvirtDomain) => {
    const result = await withSource(host, (source) => fetchLibvirtAddresses(source, uri, domain.name));
    if (!result) return;
    const address = result.addresses[0];
    if (!address) {
      showToast('warning', `${domain.name} reports no address.`);
      return;
    }
    await openSshToAddress(host, address, domain.name);
  };

  return (
    <>
      <TreeLine
        depth={depth}
        open={open}
        onToggle={() => expansion.toggle(key, true)}
        icon={<kind.Icon sx={{ fontSize: 17, color: kind.color }} />}
        title={kind.label}
        detail={uri}
        status={`${running} / ${environment.domains.length} running`}
      />
      {open
        ? visible.map((domain) => {
            const up = domain.state === 'running';
            const console = () => openEnvironmentTarget(host, { kind: 'libvirt-console', domain: domain.name, uri });
            return (
              <TreeLine
                key={domain.name}
                depth={depth + 1}
                icon={<StatusDot health={up ? 'up' : domain.state === 'paused' ? 'warn' : 'off'} />}
                title={domain.name}
                status={domain.state}
                dim={!up}
                onOpen={up ? console : undefined}
                actions={
                  <>
                    {up ? <LineAction label="Serial console (virsh console)" Icon={TerminalOutlinedIcon} onClick={console} /> : null}
                    {up ? <LineAction label="VNC display" Icon={ScreenShareOutlinedIcon} onClick={() => void vnc(domain)} /> : null}
                    {up ? <LineAction label="SSH to the VM" Icon={LoginOutlinedIcon} onClick={() => void ssh(domain)} /> : null}
                    {!up ? <LineAction label="Start" Icon={PlayArrowOutlinedIcon} onClick={() => power(domain, 'start')} /> : null}
                    <LineMenu
                      label={`More actions for ${domain.name}`}
                      entries={
                        up
                          ? [
                              { label: 'Reboot', onClick: () => power(domain, 'reboot') },
                              { label: 'Shut down…', onClick: () => power(domain, 'shutdown') },
                              { label: 'Force off…', onClick: () => power(domain, 'destroy'), destructive: true },
                            ]
                          : [{ label: 'Start', onClick: () => power(domain, 'start') }]
                      }
                    />
                  </>
                }
              />
            );
          })
        : null}
      {open ? <HiddenNote depth={depth + 1} hidden={domains.length - visible.length} noun="VM" /> : null}
    </>
  );
}
