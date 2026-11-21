import type { MonitoredHost } from '@muxus/shared';
import {
  monitoredHostAddress,
  monitoredHostFallbackLabel,
  WAITING_READING,
  type MonitorReading,
} from './host-monitor.js';
import type { KeptHostState } from './host-monitor-keep.js';
import type { EnvironmentHost } from './state/environments.js';

/** One line of the monitor: a connected host, or one the monitor is still connecting to. */
export interface MonitorRow {
  id: string;
  label: string;
  /** `user@address`, shown dimmed beside the name when it says more than the name. */
  address?: string;
  color?: string;
  /** This computer. */
  local: boolean;
  /** The backend's row; absent while a kept host has no connection yet. */
  host?: MonitoredHost;
  /** The sidebar host or ad-hoc target behind the row: how sessions to it open. */
  source?: EnvironmentHost;
  /** On the keep-connected list. */
  kept: boolean;
  /** How the monitor's own connection to a kept host stands. */
  keptState?: KeptHostState;
  reading: MonitorReading;
  /** Stays first whatever the order. */
  pinned?: boolean;
}

export interface MonitorRowsInput {
  hosts: readonly MonitoredHost[];
  readings: Readonly<Record<string, MonitorReading>>;
  /** The keep-connected list, resolved to hosts that still exist. */
  keptHosts: readonly EnvironmentHost[];
  keptStates: Readonly<Record<string, KeptHostState>>;
  /** The sidebar host or ad-hoc target a connection was dialed for. */
  resolve: (host: MonitoredHost) => EnvironmentHost | undefined;
}

/**
 * The monitor's rows: every host the backend reads, named the way the
 * sidebar names it, then the kept hosts that have no connection yet.
 */
export function buildMonitorRows({ hosts, readings, keptHosts, keptStates, resolve }: MonitorRowsInput): MonitorRow[] {
  const keptByKey = new Map(keptHosts.map((host) => [host.key, host]));
  const keptByConn = new Map<string, EnvironmentHost>();
  for (const host of keptHosts) {
    const connId = keptStates[host.key]?.connId;
    if (connId) keptByConn.set(connId, host);
  }
  const shown = new Set<string>();
  const rows: MonitorRow[] = [];
  for (const host of hosts) {
    const local = host.kind === 'local';
    const resolved = local ? undefined : resolve(host);
    // The connection the monitor dialed names its host for certain; a session's
    // connection is matched to a sidebar host by what was dialed.
    const kept =
      host.connIds.map((connId) => keptByConn.get(connId)).find(Boolean) ??
      (resolved ? keptByKey.get(resolved.key) : undefined);
    const source = kept ?? resolved;
    if (kept) shown.add(kept.key);
    const label = source?.label ?? monitoredHostFallbackLabel(host);
    const address = monitoredHostAddress(host);
    rows.push({
      id: host.id,
      label,
      ...(address && address !== label ? { address } : {}),
      ...(source?.color ? { color: source.color } : {}),
      local,
      host,
      ...(source ? { source } : {}),
      kept: !!kept,
      ...(kept && keptStates[kept.key] ? { keptState: keptStates[kept.key] } : {}),
      reading: readings[host.id] ?? WAITING_READING,
      ...(local ? { pinned: true } : {}),
    });
  }
  for (const host of keptHosts) {
    if (shown.has(host.key)) continue;
    rows.push({
      id: `kept:${host.key}`,
      label: host.label,
      ...(host.color ? { color: host.color } : {}),
      local: false,
      source: host,
      kept: true,
      ...(keptStates[host.key] ? { keptState: keptStates[host.key] } : {}),
      reading: WAITING_READING,
    });
  }
  return rows;
}

/** Lower-cased `filter` against a row's name, address and what the host calls itself. */
export function monitorRowMatches(row: MonitorRow, filter: string): boolean {
  if (!filter) return true;
  const sample = row.reading.view?.sample;
  return [row.label, row.address, row.host?.target, sample?.hostname, sample?.os].some((value) =>
    value?.toLowerCase().includes(filter),
  );
}

/** Connections the backend should read although no command ran on them yet. */
export function forcedConnections(
  rows: readonly MonitorRow[],
  asked: ReadonlySet<string>,
): string[] {
  const forced = new Set<string>();
  for (const row of rows) {
    if (!row.host) continue;
    // A kept host was asked for by name, as was a row the user told to read anyway.
    if (row.kept || asked.has(row.id)) for (const connId of row.host.connIds) forced.add(connId);
  }
  return [...forced].sort();
}
