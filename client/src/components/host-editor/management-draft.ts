import {
  GNMI_DEFAULT_PORT,
  NETCONF_DEFAULT_PORT,
  type GnmiEncoding,
  type GnmiTlsMode,
  type OpenSshMetadataPatch,
  type SavedHostProfile,
  type SavedHostProfileInput,
  type SshGateway,
  savedHostHopId,
} from '@muxus/shared';
import { hostDisplayName } from '../../host-organization.js';
import type { ManagedHost } from '../../managed-hosts.js';
import { savedHostDisplayName } from '../../saved-hosts.js';
import { parseHostTarget } from './native-draft.js';

export type ManagementKind = 'gnmi' | 'netconf';

export const DEFAULT_MANAGEMENT_PORTS: Readonly<Record<ManagementKind, number>> = {
  gnmi: GNMI_DEFAULT_PORT,
  netconf: NETCONF_DEFAULT_PORT,
};

/**
 * Form state for gNMI and NETCONF hosts. One draft serves both so switching
 * the connection type while creating keeps what was typed; an empty port
 * follows the selected protocol's default.
 */
export interface ManagementHostDraft {
  name: string;
  group: string;
  color?: string;
  host: string;
  port: string;
  username: string;
  sshGateway?: SshGateway;
  tls: GnmiTlsMode;
  tlsServerName: string;
  caFile: string;
  certFile: string;
  keyFile: string;
  /** '' picks the best encoding the device offers. */
  encoding: '' | GnmiEncoding;
}

export function blankManagementDraft(
  prefillTarget = '',
  group = '',
  sshGateway?: SshGateway,
): ManagementHostDraft {
  const { host, port, user } = parseHostTarget(prefillTarget);
  return {
    name: '',
    group,
    color: undefined,
    host,
    port: port ?? '',
    username: user ?? '',
    sshGateway,
    tls: 'verify',
    tlsServerName: '',
    caFile: '',
    certFile: '',
    keyFile: '',
    encoding: '',
  };
}

export function managementDraftFromProfile(saved: SavedHostProfile, duplicate: boolean): ManagementHostDraft {
  const profile = saved.profile;
  if (profile.kind !== 'gnmi' && profile.kind !== 'netconf') {
    throw new Error('saved host is not a gNMI or NETCONF profile');
  }
  const gnmi = profile.kind === 'gnmi' ? profile : undefined;
  return {
    name: duplicate ? `${saved.name} copy` : saved.name,
    group: saved.metadata.group ?? '',
    color: saved.metadata.color,
    host: profile.host,
    port: profile.port === DEFAULT_MANAGEMENT_PORTS[profile.kind] ? '' : String(profile.port),
    username: profile.username ?? '',
    sshGateway: profile.sshGateway,
    tls: gnmi?.tls ?? 'verify',
    tlsServerName: gnmi?.tlsServerName ?? '',
    caFile: gnmi?.caFile ?? '',
    certFile: gnmi?.certFile ?? '',
    keyFile: gnmi?.keyFile ?? '',
    encoding: gnmi?.encoding ?? '',
  };
}

export function managementDraftPort(draft: ManagementHostDraft, kind: ManagementKind): number {
  return draft.port.trim() ? Number(draft.port) : DEFAULT_MANAGEMENT_PORTS[kind];
}

export function managementDraftProblem(draft: ManagementHostDraft, kind: ManagementKind): string | null {
  if (!draft.name.trim()) return 'A name is required — it labels this host in Muxus.';
  if (!draft.host.trim()) return 'Enter a hostname or IP address.';
  if (/\s/.test(draft.host.trim())) return 'The host cannot contain spaces.';
  const port = managementDraftPort(draft, kind);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Port must be between 1 and 65535.';
  if (kind === 'gnmi' && draft.tls !== 'plaintext' && !!draft.certFile.trim() !== !!draft.keyFile.trim()) {
    return 'A client certificate needs both the certificate and its key file.';
  }
  return null;
}

export function managementDraftToInput(
  draft: ManagementHostDraft,
  kind: ManagementKind,
  existingId?: string,
): SavedHostProfileInput {
  const common = {
    host: draft.host.trim(),
    port: managementDraftPort(draft, kind),
    ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
    ...(draft.sshGateway ? { sshGateway: draft.sshGateway } : {}),
  };
  const tls = draft.tls !== 'plaintext';
  return {
    id: existingId,
    name: draft.name.trim(),
    profile:
      kind === 'gnmi'
        ? {
            kind: 'gnmi',
            ...common,
            ...(draft.tls !== 'verify' ? { tls: draft.tls } : {}),
            ...(tls && draft.tlsServerName.trim() ? { tlsServerName: draft.tlsServerName.trim() } : {}),
            ...(tls && draft.caFile.trim() ? { caFile: draft.caFile.trim() } : {}),
            ...(tls && draft.certFile.trim() ? { certFile: draft.certFile.trim() } : {}),
            ...(tls && draft.keyFile.trim() ? { keyFile: draft.keyFile.trim() } : {}),
            ...(draft.encoding ? { encoding: draft.encoding } : {}),
          }
        : { kind: 'netconf', ...common },
  };
}

/** Muxus-only metadata written right after the host itself saves. */
export function managementDraftMetadataPatch(draft: ManagementHostDraft): OpenSshMetadataPatch {
  return {
    group: draft.group.trim() || null,
    color: draft.color ?? null,
  };
}

/** What the host editor opens with when adding a gNMI or NETCONF host for an SSH one. */
export interface ManagementHostPrefill {
  mode: 'new';
  kind: ManagementKind;
  prefillTarget: string;
  prefillName: string;
  prefillGateway?: SshGateway;
  group?: string;
}

/**
 * A new gNMI or NETCONF host for the device an SSH host reaches: same
 * address and user, same folder, through the same jump host. NETCONF keeps an
 * ssh_config alias as its host so that config's keys and jump hosts still
 * apply; otherwise the last jump hop becomes the SSH gateway, which reaches
 * its own earlier hops when it is a saved host or ssh_config alias.
 */
export function managementHostPrefill(
  host: ManagedHost,
  kind: ManagementKind,
  savedProfiles: readonly SavedHostProfile[],
): ManagementHostPrefill {
  const protocol = kind === 'gnmi' ? 'gNMI' : 'NETCONF';
  if (host.kind === 'ssh') {
    const { resolved } = host.entry;
    const target = kind === 'netconf' ? host.entry.alias : resolved.hostname;
    const gateway = kind === 'gnmi' ? jumpGateway(resolved.proxyJump, savedProfiles) : undefined;
    return {
      mode: 'new',
      kind,
      prefillTarget: `${resolved.user ? `${resolved.user}@` : ''}${target}`,
      prefillName: `${hostDisplayName(host.entry)} (${protocol})`,
      ...(gateway ? { prefillGateway: gateway } : {}),
      group: host.entry.metadata?.group,
    };
  }
  const profile = host.entry.profile;
  // The SSH port means nothing to gNMI or NETCONF: keep only the host.
  const address = profile.kind === 'ssh' ? profile.target.replace(/^[^@]*@/, '') : '';
  const target = address.split(':').length === 2 ? address.split(':')[0]! : address;
  const user = profile.kind === 'ssh' ? (profile.user ?? (profile.target.includes('@') ? profile.target.split('@')[0] : undefined)) : undefined;
  const gateway = profile.kind === 'ssh' ? jumpGateway(profile.proxyJump ?? [], savedProfiles) : undefined;
  return {
    mode: 'new',
    kind,
    prefillTarget: `${user ? `${user}@` : ''}${target}`,
    prefillName: `${savedHostDisplayName(host.entry)} (${protocol})`,
    ...(gateway ? { prefillGateway: gateway } : {}),
    group: host.entry.metadata.group,
  };
}

/** The SSH gateway standing in for a jump list: its last hop, as a saved host when it names one. */
function jumpGateway(hops: readonly string[], savedProfiles: readonly SavedHostProfile[]): SshGateway | undefined {
  const last = hops.at(-1);
  if (!last || last.toLowerCase() === 'none') return undefined;
  const id = savedHostHopId(last);
  if (id === undefined) return { target: last };
  const saved = savedProfiles.find((candidate) => candidate.id === id)?.profile;
  return saved?.kind === 'ssh' ? { target: saved.target, profileId: id } : undefined;
}
