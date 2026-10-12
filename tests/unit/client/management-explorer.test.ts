import { describe, expect, it, vi } from 'vitest';
import {
  formatGnmiPath,
  parseGnmiPath,
  stripModulePrefix,
  type GnmiNotification,
  type GnmiSessionInfo,
  type ManagementProfile,
} from '@muxus/shared';
import { WorkbenchController } from '../../../client/src/management/controller.js';
import { nodeLabel, type DataNode } from '../../../client/src/management/data-tree.js';
import { ManagementRequestError, type ManagementConnection } from '../../../client/src/management/session-client.js';
import { createWorkbenchStore } from '../../../client/src/management/workbench-store.js';

type Json = Record<string, unknown>;

function isLeaf(value: unknown): boolean {
  return typeof value !== 'object' || value === null || (Array.isArray(value) && value.every((item) => typeof item !== 'object'));
}

/**
 * The gNMI depth extension as specified: `depth` levels below the path, the
 * last one carrying leaves and leaf-lists only. A container with nothing left
 * in reach is left out. A list and its entries are one level.
 */
function prune(value: Json, depth: number): Json {
  if (depth === 0) return value;
  const out: Json = {};
  for (const [name, child] of Object.entries(value)) {
    if (isLeaf(child)) {
      out[name] = child;
    } else if (depth > 1 && Array.isArray(child)) {
      const entries = (child as Json[]).map((entry) => prune(entry, depth - 1)).filter((entry) => Object.keys(entry).length);
      if (entries.length) out[name] = entries;
    } else if (depth > 1) {
      const pruned = prune(child as Json, depth - 1);
      if (Object.keys(pruned).length) out[name] = pruned;
    }
  }
  return out;
}

/**
 * A device that answers Gets from `data`, rejecting module names in paths as
 * SR OS does. With `splitRoot`, the top level comes as one update per branch,
 * also like SR OS.
 */
function fakeDevice(data: Json, splitRoot: boolean) {
  const requests: { path: string; depth?: number }[] = [];
  const valueAt = (path: string): unknown => {
    let value: unknown = data;
    for (const elem of parseGnmiPath(path).elems) {
      if (elem.name.includes(':')) throw new ManagementRequestError({ message: `${elem.name} - Unknown element` }, 0);
      const object = value as Json;
      const member = Object.keys(object).find((name) => stripModulePrefix(name) === elem.name);
      value = member === undefined ? undefined : object[member];
      if (elem.keys && Array.isArray(value)) {
        value = (value as Json[]).find((entry) =>
          Object.entries(elem.keys ?? {}).every(([key, wanted]) => String(entry[key]) === wanted),
        );
      }
      if (value === undefined) throw new ManagementRequestError({ message: `${path} - Unknown element` }, 0);
    }
    return value;
  };
  const get = (path: string, depth = 0): GnmiNotification[] => {
    const value = valueAt(path) as Json;
    const updates =
      path === '/' && splitRoot
        ? Object.entries(value).map(([name, top]) => ({ path: `/${name}`, value: prune(top as Json, depth && depth - 1) }))
        : [{ path, value: prune(value, depth) }];
    const shown = updates.filter((update) => Object.keys(update.value).length);
    return [
      {
        timestamp: '1',
        updates: shown.length
          ? shown.map((update) => ({ path: update.path, value: { type: 'json_ietf' as const, value: update.value } }))
          : [{ path, value: { type: 'none' as const, value: null } }],
        deletes: [],
      },
    ];
  };
  const connection = {
    closed: false,
    request(message: { op: string; paths: string[]; depth?: number; maxBytes?: number }) {
      const promise = (async () => {
        await Promise.resolve();
        const path = message.paths[0]!;
        requests.push({ path, ...(message.depth ? { depth: message.depth } : {}) });
        const notifications = get(path, message.depth);
        const bytes = JSON.stringify(notifications).length;
        if (message.maxBytes !== undefined && bytes > message.maxBytes) {
          throw new ManagementRequestError({ code: 'RESOURCE_EXHAUSTED', message: 'too large' }, 0);
        }
        return { result: { op: 'gnmi-get' as const, notifications }, durationMs: 1, bytes };
      })();
      return { id: 'r', promise, cancel: () => undefined };
    },
    subscribe(_message: unknown, handlers: { sync: () => void }) {
      queueMicrotask(() => handlers.sync());
      return { id: 's', cancel: () => undefined, poll: () => undefined };
    },
  };
  return { connection: connection as unknown as ManagementConnection, requests };
}

function explorer(data: Json, splitRoot = false) {
  const device = fakeDevice(data, splitRoot);
  const store = createWorkbenchStore('gnmi');
  const info: GnmiSessionInfo = {
    protocol: 'gnmi',
    address: 'admin@sr1:57400',
    connectedAt: '',
    version: '0.8.0',
    encodings: ['json_ietf'],
    models: [],
    tls: { mode: 'plaintext' },
  };
  const profile = { kind: 'gnmi', host: 'sr1', port: 57400 } as ManagementProfile;
  const controller = new WorkbenchController(store, device.connection, profile, info);
  const root = () => store.getState().explorer.root;
  return { controller, root, requests: device.requests };
}

function child(node: DataNode, label: string): DataNode {
  const found = node.children.find((candidate) => nodeLabel(candidate) === label);
  if (!found) throw new Error(`${nodeLabel(node)} has no ${label}: ${node.children.map(nodeLabel).join(', ')}`);
  return found;
}

const labels = (node: DataNode) => node.children.map(nodeLabel);

describe('gNMI explorer', () => {
  it('looks deeper when the depth extension hides the top level, as on SR OS', async () => {
    const { controller, root, requests } = explorer({
      configure: {
        'nokia-conf:system': { name: 'sr1' },
        'nokia-conf:log': { filter: [{ 'filter-name': '1001', 'named-entry': [{ 'entry-name': '10' }] }] },
      },
      state: {
        'nokia-state:system': { 'oper-name': 'sr1' },
        'nokia-state:service': { vprn: [{ 'service-name': 'blue', 'oper-state': 'up' }] },
      },
    }, true);
    await controller.loadNode(root());
    // Depth 2 shows nothing at all; the explorer does not stop there.
    expect(requests.slice(0, 2)).toEqual([
      { path: '/', depth: 2 },
      { path: '/', depth: 3 },
    ]);
    expect(labels(root())).toEqual(['configure', 'state']);
    // The branches without values near the top arrive once the whole tree is in.
    await vi.waitFor(() => expect(labels(child(root(), 'state'))).toEqual(['system', 'service']));
    expect(labels(child(root(), 'configure'))).toEqual(['system', 'log']);
    expect(requests.at(-1)).toEqual({ path: '/' });
    expect(child(child(root(), 'state'), 'service').loaded).toBe(true);
    // Paths built from the tree name no module, which SR OS would reject.
    expect(formatGnmiPath(child(child(root(), 'configure'), 'system').path)).toBe('/configure/system');
  });

  it('adds the branches a depth-limited look left out below a node', async () => {
    const { controller, root } = explorer({
      'network-instance': [
        { name: 'mgmt', type: 'ip-vrf', protocols: { bgp: { 'admin-state': 'enable' } }, 'route-table': { ipv4: { route: [{ prefix: '0.0.0.0/0' }] } } },
      ],
    });
    await controller.loadNode(root());
    const entry = child(child(root(), 'network-instance'), 'mgmt');
    await controller.loadNode(entry);
    expect(labels(entry)).toEqual(['name', 'type']);
    await vi.waitFor(() => expect(labels(entry)).toEqual(['name', 'type', 'protocols', 'route-table']));
    expect(formatGnmiPath(child(entry, 'protocols').path)).toBe('/network-instance[name=mgmt]/protocols');
  });

  it('keeps what it shows when a deeper look grows too large', async () => {
    const route = Array.from({ length: 4000 }, (_, index) => ({ prefix: `10.${index >> 8}.${index & 255}.0/24`, path: 'x'.repeat(1200) }));
    const { controller, root, requests } = explorer({ system: { name: 'r1', rib: { 'route-count': 4000, route } } });
    await controller.loadNode(root());
    const system = child(root(), 'system');
    await controller.loadNode(system);
    expect(labels(system)).toEqual(['name', 'rib']);
    // The routes are past the limit: that look gives up, and the first one stays.
    await vi.waitFor(() => expect(requests).toContainEqual({ path: '/system', depth: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(labels(system)).toEqual(['name', 'rib']);
    expect(child(system, 'rib').loaded).toBeFalsy();
    expect(requests).not.toContainEqual({ path: '/system' });
  });
});
