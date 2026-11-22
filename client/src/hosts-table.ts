import type { SavedHostProfile } from '@muxus/shared';
import { folderSegments } from './host-tree.js';
import {
  managedHostAddress,
  managedHostDisplayName,
  managedHostKey,
  type ManagedHost,
} from './managed-hosts.js';
import { jumpHopLabel } from './saved-hosts.js';

/**
 * The hosts tab's table, kept free of React: what each column says for a host
 * and how a column sorts.
 */
export {
  DEFAULT_HOSTS_TABLE_SORT,
  HOSTS_TABLE_COLUMNS,
  isHostsTableSort,
  nextHostsTableSort,
  type HostsTableColumn,
  type HostsTableSort,
} from './hosts-table-sort.js';
import type { HostsTableSort } from './hosts-table-sort.js';

export type HostKind = 'ssh' | SavedHostProfile['kind'];

export const HOST_KIND_LABELS: Record<HostKind, string> = {
  ssh: 'SSH',
  telnet: 'Telnet',
  serial: 'Serial',
  rdp: 'RDP',
  vnc: 'VNC',
  gnmi: 'gNMI',
  netconf: 'NETCONF',
  web: 'Web',
};

/** The connection kind a host opens with, whichever source it is saved in. */
export function managedHostKind(host: ManagedHost): HostKind {
  return host.kind === 'ssh' ? 'ssh' : host.entry.kind;
}

/** When the host was last connected, in epoch milliseconds. */
export function lastConnectedTime(host: ManagedHost): number | undefined {
  const at = host.entry.metadata?.lastConnectedAt;
  if (!at) return undefined;
  const time = Date.parse(at);
  return Number.isNaN(time) ? undefined : time;
}

/** The folder a host is filed in, as shown: `Production / Web`, or '' for none. */
export function hostFolderLabel(host: ManagedHost, belowDepth = 0): string {
  return folderSegments(host.entry.metadata?.group).slice(belowDepth).join(' / ');
}

/** The hosts or gateway a connection goes through first: `bastion`, `a → b`, or ''. */
export function hostJumpRoute(
  host: ManagedHost,
  savedProfiles?: readonly SavedHostProfile[],
): string {
  if (host.kind === 'ssh') return (host.entry.resolved?.proxyJump ?? []).join(' → ');
  const profile = host.entry.profile;
  if (profile.kind === 'ssh') {
    return (profile.proxyJump ?? []).map((hop) => jumpHopLabel(hop, savedProfiles)).join(' → ');
  }
  if (
    profile.kind === 'rdp' ||
    profile.kind === 'vnc' ||
    profile.kind === 'gnmi' ||
    profile.kind === 'netconf' ||
    profile.kind === 'web'
  ) {
    return profile.sshGateway?.target ?? '';
  }
  return '';
}

export interface HostsTableRow {
  key: string;
  host: ManagedHost;
  name: string;
  address: string;
  folder: string;
  via: string;
  kind: HostKind;
  lastUsed?: number;
}

export function hostsTableRow(
  host: ManagedHost,
  savedProfiles?: readonly SavedHostProfile[],
): HostsTableRow {
  return {
    key: managedHostKey(host),
    host,
    name: managedHostDisplayName(host),
    address: managedHostAddress(host),
    folder: hostFolderLabel(host),
    via: hostJumpRoute(host, savedProfiles),
    kind: managedHostKind(host),
    lastUsed: lastConnectedTime(host),
  };
}

const compareText = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

/**
 * Rows in the order a sort asks for. Empty cells sink to the bottom in either
 * direction — a column of blanks above the values it was sorted for helps
 * nobody — and ties fall back to the name, so the order never looks random.
 */
export function sortHostsTableRows(
  rows: readonly HostsTableRow[],
  sort: HostsTableSort,
): HostsTableRow[] {
  const column = sort.column;
  if (!column) return [...rows];
  const direction = sort.descending ? -1 : 1;
  const byName = (a: HostsTableRow, b: HostsTableRow) => compareText(a.name, b.name);
  return rows.toSorted((a, b) => {
    if (column === 'lastUsed') {
      if (a.lastUsed === b.lastUsed) return byName(a, b);
      if (a.lastUsed === undefined) return 1;
      if (b.lastUsed === undefined) return -1;
      return (a.lastUsed - b.lastUsed) * direction;
    }
    const left = column === 'kind' ? HOST_KIND_LABELS[a.kind] : a[column];
    const right = column === 'kind' ? HOST_KIND_LABELS[b.kind] : b[column];
    if (left === right) return byName(a, b);
    if (!left) return 1;
    if (!right) return -1;
    return compareText(left, right) * direction || byName(a, b);
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Whole calendar days between two moments, in local time. */
export function calendarDaysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY_MS);
}

/** "Today", "Yesterday", "5 days ago", "3 weeks ago", "2 months ago", "Never". */
export function formatLastUsed(time: number | undefined, now: number): string {
  if (time === undefined) return 'Never';
  const days = Math.max(0, calendarDaysBetween(time, now));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'A year ago' : `${years} years ago`;
}
