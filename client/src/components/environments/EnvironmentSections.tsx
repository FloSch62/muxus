import Box from '@mui/material/Box';
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
  type EnvironmentTarget,
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
import { useSavedHostProfiles, useSshConfig } from '../../api/queries.js';
import { copyToClipboard } from '../../clipboard.js';
import { addAddressToHosts, addEnvironmentToHosts, type HostDirectory } from '../../environment-hosts.js';
import { environmentSource, isRunning, plainContainers } from '../../environments.js';
import {
  nodeUsesSsh,
  openContainerlabNode,
  openEnvironmentTarget,
  openHostPort,
  openSshToAddress,
  openVncOnHost,
  portScheme,
} from '../../environment-sessions.js';
import type { EnvironmentHost, HostEnvironmentsEntry } from '../../state/environments.js';
import { unavailableWithSystemOpenSsh } from '../../system-openssh.js';
import { showToast } from '../../state/toast.js';
import { ENVIRONMENT_KINDS, EnvironmentLogo } from './environment-icons.js';
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

/** The sidebar's hosts, for copying a parent host's connection settings. */
function useHostDirectory(): HostDirectory {
  const { data: config } = useSshConfig();
  const { data: saved } = useSavedHostProfiles();
  return { sshHosts: config?.hosts ?? [], savedProfiles: saved?.profiles ?? [] };
}

/**
 * Keep a guest as a sidebar host: SSH to the address it reports, through the
 * hypervisor, or its console when it reports none.
 */
/**
 * A saved host only exists as a jump hop inside Muxus, and only the ssh program
 * can log in to a host set to use it, so such a host has no way to be jumped through.
 */
function jumpUnavailable(host: EnvironmentHost): boolean {
  return host.systemOpenSsh === true && !!host.profile?.profileId;
}

async function addGuestToHosts(
  host: HostEnvironmentsEntry,
  hosts: HostDirectory,
  name: string,
  addresses: (source: EnvironmentSource) => Promise<{ addresses: string[] }>,
  console: EnvironmentTarget,
): Promise<void> {
  const result = await withSource(host, addresses);
  if (!result) return;
  const address = result.addresses[0];
  if (address) addAddressToHosts(host, hosts, { name, address });
  else addEnvironmentToHosts(host, hosts, name, console);
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
        icon={<EnvironmentLogo kind={environment.runtime} />}
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
  const hosts = useHostDirectory();
  const shell = (shellName?: 'bash' | 'sh') =>
    openEnvironmentTarget(host, {
      kind: 'container',
      runtime,
      container: container.name,
      ...(shellName ? { shell: shellName } : {}),
    });
  const logs = () => openEnvironmentTarget(host, { kind: 'container-logs', runtime, container: container.name });
  const lifecycle = (action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove') =>
    act(
      { kind: 'container', runtime, container: container.name, action },
      action === 'stop'
        ? { title: `Stop ${container.name}?`, description: 'Its processes are asked to exit.' }
        : action === 'remove'
          ? {
              title: `Remove ${container.name}?`,
              description: `${up ? 'The container is stopped and deleted' : 'The container is deleted'}, with what it wrote outside its volumes. Its image and named volumes are kept.`,
            }
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
      label: 'Add to hosts',
      onClick: () => addEnvironmentToHosts(host, hosts, container.name, { kind: 'container', runtime, container: container.name }),
    },
    {
      label: 'Copy exec command',
      onClick: () =>
        void copyToClipboard(
          environmentCommandLine({ kind: 'container', runtime, container: container.name }),
        ),
      divider: true,
    },
    { label: 'Remove…', onClick: () => lifecycle('remove'), destructive: true },
  ];

  return (
    <>
      <TreeLine
        depth={depth}
        icon={<StatusDot health={containerHealth(container)} />}
        title={container.name}
        detail={<Box component="span" sx={MONO}>{container.image}</Box>}
        status={container.status}
        hint={[
          ['Image', container.image],
          ['Status', container.status],
          ['Compose', container.composeProject],
          ['ID', container.id.slice(0, 12)],
          [
            'Ports',
            container.ports
              .map((port) =>
                port.hostPort
                  ? `${port.hostIp ? `${port.hostIp}:` : ''}${port.hostPort}→${port.containerPort}/${port.protocol}`
                  : `${port.containerPort}/${port.protocol}`,
              )
              .join(', '),
          ],
        ]}
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
              disabled={host.systemOpenSsh}
              title={host.systemOpenSsh ? unavailableWithSystemOpenSsh('Open this port') : `Open ${portScheme(port.hostPort!)}://…:${port.hostPort}${host.profile ? `, forwarded from ${host.label}` : ''}`}
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
        icon={<EnvironmentLogo kind="containerlab" />}
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
  const hosts = useHostDirectory();
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
        hint={[
          ['Topology', lab.topologyFile],
          ['Owner', lab.owner],
          ['Nodes', `${running.length} of ${lab.nodes.length} running`],
        ]}
        emphasis
        actions={
          <>
            <LineAction
              label="Show topology"
              Icon={HubOutlinedIcon}
              disabled={!lab.topologyFile}
              onClick={() => onTopology(lab)}
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
                hint={[
                  ['Kind', node.kind],
                  ['Image', node.image],
                  ['State', node.state],
                  ['IPv4', node.ipv4],
                  ['IPv6', node.ipv6],
                  ['Container', node.container],
                ]}
                dim={!up}
                onOpen={up && !(ssh && host.systemOpenSsh) ? () => openContainerlabNode(host, lab, node) : undefined}
                actions={
                  <>
                    <LineAction
                      label={
                        ssh
                          ? host.systemOpenSsh
                            ? unavailableWithSystemOpenSsh(`SSH to ${node.ipv4} as admin`)
                            : `SSH to ${node.ipv4} as admin`
                          : 'Open shell'
                      }
                      Icon={ssh ? LoginOutlinedIcon : TerminalOutlinedIcon}
                      disabled={!up || (ssh && host.systemOpenSsh)}
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
                        {
                          label: 'Add to hosts',
                          disabled: ssh && jumpUnavailable(host),
                          onClick: () =>
                            ssh
                              ? addAddressToHosts(host, hosts, {
                                  name: `${lab.name}-${node.name}`,
                                  address: node.ipv4!,
                                  user: 'admin',
                                  group: lab.name,
                                })
                              : addEnvironmentToHosts(host, hosts, `${lab.name}-${node.name}`, {
                                  kind: 'container',
                                  runtime: lab.runtime,
                                  container: node.container,
                                }),
                        },
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
  const hosts = useHostDirectory();
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
        icon={<EnvironmentLogo kind="proxmox" />}
        title={kind.label}
        detail={environment.version}
        status={`${running} / ${environment.guests.length} running`}
        actions={
          <LineAction
            label={
              host.systemOpenSsh
                ? unavailableWithSystemOpenSsh('Open the web interface')
                : 'Open the web interface (https :8006)'
            }
            disabled={host.systemOpenSsh}
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
                hint={[
                  ['Type', guest.type === 'qemu' ? 'Virtual machine' : 'Container (LXC)'],
                  ['ID', guest.vmid],
                  ['Node', guest.node],
                  ['Status', guest.template ? 'template' : guest.status],
                  ['Load', up && guest.maxcpu ? load : undefined],
                ]}
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
                      <LineAction
                        label={host.systemOpenSsh ? unavailableWithSystemOpenSsh('SSH to the guest') : 'SSH to the guest'}
                        disabled={host.systemOpenSsh}
                        Icon={LoginOutlinedIcon}
                        onClick={() => void sshToGuest(host, guest)}
                      />
                    ) : null}
                    {!up && !guest.template ? (
                      <LineAction label="Start" Icon={PlayArrowOutlinedIcon} onClick={() => power(guest, 'start')} />
                    ) : null}
                    <LineMenu
                      label={`More actions for ${guest.name}`}
                      entries={[
                        ...(up
                          ? [
                              { label: 'Reboot', onClick: () => power(guest, 'reboot') },
                              { label: 'Shut down…', onClick: () => power(guest, 'shutdown') },
                              { label: 'Stop (force)…', onClick: () => power(guest, 'stop'), destructive: true, divider: true },
                            ]
                          : guest.template
                            ? []
                            : [{ label: 'Start', onClick: () => power(guest, 'start'), divider: true }]),
                        ...(guest.template
                          ? []
                          : [
                              {
                                label: 'Add to hosts',
                                disabled: jumpUnavailable(host),
                                onClick: () =>
                                  void addGuestToHosts(
                                    host,
                                    hosts,
                                    guest.name,
                                    (source) => fetchProxmoxAddresses(source, guest.type, guest.vmid),
                                    guest.type === 'lxc'
                                      ? { kind: 'proxmox-lxc', vmid: guest.vmid }
                                      : { kind: 'proxmox-serial', vmid: guest.vmid },
                                  ),
                              },
                            ]),
                      ]}
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
  const key = `${host.key}/libvirt`;
  const open = expansion.isOpen(key, true);
  const domains = environment.domains.filter((domain) => matches(filter, domain.name));
  const visible = domains.filter((domain) => showStopped || domain.state === 'running');
  const running = environment.domains.filter((domain) => domain.state === 'running').length;
  const hosts = useHostDirectory();
  if (filter && domains.length === 0) return null;

  const power = (domain: LibvirtDomain, action: 'start' | 'shutdown' | 'reboot' | 'destroy') =>
    act(
      { kind: 'libvirt', uri: domain.uri, domain: domain.name, action },
      action === 'destroy'
        ? { title: `Force off ${domain.name}?`, description: 'The VM is switched off without shutting down.' }
        : action === 'shutdown'
          ? { title: `Shut down ${domain.name}?`, description: 'The VM is asked to shut down.' }
          : undefined,
    );
  const vnc = async (domain: LibvirtDomain) => {
    const result = await withSource(host, (source) => fetchLibvirtDisplay(source, domain.uri, domain.name));
    if (!result) return;
    if (!result.vnc) {
      showToast('warning', `${domain.name} has no VNC display.`);
      return;
    }
    openVncOnHost(host, result.vnc, domain.name);
  };
  const ssh = async (domain: LibvirtDomain) => {
    const result = await withSource(host, (source) => fetchLibvirtAddresses(source, domain.uri, domain.name));
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
        icon={<EnvironmentLogo kind="libvirt" />}
        title={kind.label}
        detail={environment.version ? `libvirt ${environment.version}` : undefined}
        status={`${running} / ${environment.domains.length} running`}
      />
      {open
        ? visible.map((domain) => {
            const up = domain.state === 'running';
            const console = () => openEnvironmentTarget(host, { kind: 'libvirt-console', domain: domain.name, uri: domain.uri });
            return (
              <TreeLine
                key={`${domain.uri ?? ''}:${domain.name}`}
                depth={depth + 1}
                icon={<StatusDot health={up ? 'up' : domain.state === 'paused' ? 'warn' : 'off'} />}
                title={domain.name}
                detail={domain.uri === 'qemu:///session' ? 'user session' : undefined}
                status={domain.state}
                hint={[
                  ['State', domain.state],
                  ['Connection', domain.uri],
                  ['ID', domain.id],
                ]}
                dim={!up}
                onOpen={up ? console : undefined}
                actions={
                  <>
                    {up ? <LineAction label="Serial console (virsh console)" Icon={TerminalOutlinedIcon} onClick={console} /> : null}
                    {up ? <LineAction label={host.systemOpenSsh ? unavailableWithSystemOpenSsh('VNC display') : 'VNC display'} disabled={host.systemOpenSsh} Icon={ScreenShareOutlinedIcon} onClick={() => void vnc(domain)} /> : null}
                    {up ? <LineAction label={host.systemOpenSsh ? unavailableWithSystemOpenSsh('SSH to the VM') : 'SSH to the VM'} disabled={host.systemOpenSsh} Icon={LoginOutlinedIcon} onClick={() => void ssh(domain)} /> : null}
                    {!up ? <LineAction label="Start" Icon={PlayArrowOutlinedIcon} onClick={() => power(domain, 'start')} /> : null}
                    <LineMenu
                      label={`More actions for ${domain.name}`}
                      entries={
                        [
                          ...(up
                            ? [
                                { label: 'Reboot', onClick: () => power(domain, 'reboot') },
                                { label: 'Shut down…', onClick: () => power(domain, 'shutdown') },
                                { label: 'Force off…', onClick: () => power(domain, 'destroy'), destructive: true, divider: true },
                              ]
                            : [{ label: 'Start', onClick: () => power(domain, 'start'), divider: true }]),
                          {
                            label: 'Add to hosts',
                            disabled: jumpUnavailable(host),
                            onClick: () =>
                              void addGuestToHosts(
                                host,
                                hosts,
                                domain.name,
                                (source) => fetchLibvirtAddresses(source, domain.uri, domain.name),
                                { kind: 'libvirt-console', domain: domain.name, uri: domain.uri },
                              ),
                          },
                        ]
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
