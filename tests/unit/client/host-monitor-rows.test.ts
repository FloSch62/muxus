import { describe, expect, it } from 'vitest';
import type { MonitoredHost } from '@muxus/shared';
import type { MonitorReading } from '../../../client/src/host-monitor.js';
import {
  buildMonitorRows,
  forcedConnections,
  monitorRowMatches,
} from '../../../client/src/host-monitor-rows.js';
import type { EnvironmentHost } from '../../../client/src/state/environments.js';

const LOCAL: MonitoredHost = { id: 'local', kind: 'local', connIds: [] };
const WEB: MonitoredHost = {
  id: 'ssh::deploy@10.0.0.4:22',
  kind: 'ssh',
  connIds: ['c1', 'c2'],
  target: 'web-01',
  host: '10.0.0.4',
  port: 22,
  user: 'deploy',
};
const ADHOC: MonitoredHost = {
  id: 'ssh::root@192.0.2.9:22',
  kind: 'ssh',
  connIds: ['c7'],
  target: 'root@192.0.2.9',
  host: '192.0.2.9',
  port: 22,
  user: 'root',
};

const WEB_HOST: EnvironmentHost = { key: 'ssh:web-01', label: 'Web 01', color: '#3b82f6', profile: { kind: 'ssh', target: 'web-01' } };
const BUILD_HOST: EnvironmentHost = { key: 'ssh:build-01', label: 'build-01', profile: { kind: 'ssh', target: 'build-01' } };

/** Sidebar hosts by what was dialed, the way the view resolves them. */
const resolve = (host: MonitoredHost) => (host.target === 'web-01' ? WEB_HOST : undefined);

const OK: MonitorReading = { status: 'ok', view: { sample: { hostname: 'web-01.internal', os: 'Debian 12' } } };

describe('the monitor’s rows', () => {
  it('names a connected host the way the sidebar does, and keeps this computer on top', () => {
    const rows = buildMonitorRows({ hosts: [LOCAL, WEB], readings: { [WEB.id]: OK }, keptHosts: [], keptStates: {}, resolve });
    expect(rows).toMatchObject([
      { id: 'local', label: 'This computer', local: true, pinned: true, kept: false, reading: { status: 'waiting' } },
      { id: WEB.id, label: 'Web 01', address: 'deploy@10.0.0.4', color: '#3b82f6', kept: false, source: WEB_HOST, reading: OK },
    ]);
  });

  it('shows an ad-hoc target under what was dialed, without repeating it as its address', () => {
    const [row] = buildMonitorRows({ hosts: [ADHOC], readings: {}, keptHosts: [], keptStates: {}, resolve });
    expect(row).toMatchObject({ label: 'root@192.0.2.9', kept: false });
    expect(row!.address).toBeUndefined();
    expect(row!.source).toBeUndefined();
  });

  it('gives a kept host a row before it has a connection', () => {
    const rows = buildMonitorRows({
      hosts: [LOCAL],
      readings: {},
      keptHosts: [BUILD_HOST],
      keptStates: { [BUILD_HOST.key]: { status: 'sign-in', message: 'Sign-in needed' } },
      resolve,
    });
    expect(rows[1]).toMatchObject({
      id: 'kept:ssh:build-01',
      label: 'build-01',
      kept: true,
      keptState: { status: 'sign-in' },
      reading: { status: 'waiting' },
    });
    expect(rows[1]!.host).toBeUndefined();
  });

  it('marks the row of the connection the monitor itself holds as kept, once', () => {
    const rows = buildMonitorRows({
      hosts: [LOCAL, { ...ADHOC, target: 'build-01', connIds: ['c9'] }],
      readings: {},
      keptHosts: [BUILD_HOST],
      keptStates: { [BUILD_HOST.key]: { status: 'connected', connId: 'c9' } },
      resolve,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ label: 'build-01', kept: true, source: BUILD_HOST, keptState: { status: 'connected' } });
  });

  it('marks a host kept that a session already connected, while the monitor’s own dial is still on its way', () => {
    const rows = buildMonitorRows({
      hosts: [WEB],
      readings: {},
      keptHosts: [WEB_HOST],
      keptStates: { [WEB_HOST.key]: { status: 'connecting' } },
      resolve,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: WEB.id, kept: true });
  });

  it('filters by name, address and what the host calls itself', () => {
    const [row] = buildMonitorRows({ hosts: [WEB], readings: { [WEB.id]: OK }, keptHosts: [], keptStates: {}, resolve });
    for (const filter of ['', 'web 01', '10.0.0', 'internal', 'debian', 'web-01']) {
      expect(monitorRowMatches(row!, filter)).toBe(true);
    }
    expect(monitorRowMatches(row!, 'db')).toBe(false);
  });
});

describe('connections read on request', () => {
  it('asks for kept hosts and for rows the user told to read, over every connection they have', () => {
    const rows = buildMonitorRows({
      hosts: [LOCAL, WEB, ADHOC],
      readings: {},
      keptHosts: [WEB_HOST],
      keptStates: { [WEB_HOST.key]: { status: 'connected', connId: 'c2' } },
      resolve,
    });
    expect(forcedConnections(rows, new Set())).toEqual(['c1', 'c2']);
    expect(forcedConnections(rows, new Set([ADHOC.id]))).toEqual(['c1', 'c2', 'c7']);
  });

  it('asks for nothing by default', () => {
    const rows = buildMonitorRows({ hosts: [LOCAL, WEB, ADHOC], readings: {}, keptHosts: [], keptStates: {}, resolve });
    expect(forcedConnections(rows, new Set())).toEqual([]);
  });
});
