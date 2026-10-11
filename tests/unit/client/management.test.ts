import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMParser as XmlDomParser, XMLSerializer as XmlDomSerializer } from '@xmldom/xmldom';
import { parseGnmiPath, type GnmiNotification } from '@muxus/shared';
import {
  collectLeaves,
  createRoot,
  guessListKeys,
  KeyRegistry,
  mergeJson,
  mergeXml,
  namespaceChain,
  nodeAt,
  nodeLabel,
  nodeToJson,
  type DataNode,
} from '../../../client/src/management/data-tree.js';
import { flattenValue, formatRate, formatSi, LiveTable } from '../../../client/src/management/live-table.js';
import {
  defaultGnmiDraft,
  defaultNetconfDraft,
  gnmiDraftProblem,
  gnmiSetMessage,
  gnmiSubscribeMessage,
  netconfRpcBody,
  normalizeDraft,
} from '../../../client/src/management/requests.js';
import { canonicalJson, mergeValue, proposedValue } from '../../../client/src/management/set-review.js';
import { accountingRecord, parseAuthorizedKeys, permissionString } from '../../../client/src/management/tool-format.js';
import { gnmicCommand, ncclientScript, shellQuote } from '../../../client/src/management/copy-as.js';
import {
  editConfigFor,
  parseRpcReply,
  prettyXml,
  subtreeFilterFor,
  unwrapRpc,
  xmlFragmentError,
  xpathFor,
} from '../../../client/src/management/xml.js';

const globals = globalThis as Record<string, unknown>;
const saved = { DOMParser: globals.DOMParser, XMLSerializer: globals.XMLSerializer, Node: globals.Node };

beforeAll(() => {
  // Browsers report malformed XML as a <parsererror> document; xmldom throws.
  class BrowserLikeParser {
    parseFromString(text: string, mimeType: string): Document {
      try {
        return new XmlDomParser().parseFromString(text, mimeType) as unknown as Document;
      } catch (err) {
        return new XmlDomParser().parseFromString(
          `<parsererror>error on line 1: ${(err as Error).message}</parsererror>`,
          'application/xml',
        ) as unknown as Document;
      }
    }
  }
  globals.DOMParser = BrowserLikeParser;
  globals.XMLSerializer = XmlDomSerializer;
  // Constants only; a class so `instanceof Node` checks elsewhere stay valid.
  globals.Node = class {
    static ELEMENT_NODE = 1;
    static TEXT_NODE = 3;
    static CDATA_SECTION_NODE = 4;
    static COMMENT_NODE = 8;
  };
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

function find(root: DataNode, label: string): DataNode {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (nodeLabel(node) === label) return node;
    stack.push(...node.children);
  }
  throw new Error(`no node ${label}`);
}

describe('device data tree', () => {
  it('builds lists from JSON with guessed keys and from keyed paths with learned keys', () => {
    const registry = new KeyRegistry();
    const root = createRoot();
    mergeJson(
      root,
      {
        'srl_nokia-interfaces:interface': [
          { name: 'ethernet-1/1', 'admin-state': 'enable', statistics: { 'in-octets': '10' } },
          { name: 'mgmt0', 'admin-state': 'enable' },
        ],
      },
      registry,
    );
    const entry = find(root, 'ethernet-1/1');
    expect(entry.kind).toBe('entry');
    expect(entry.guessedKeys).toBe(true);
    expect(entry.path.elems[0]).toEqual({ name: 'srl_nokia-interfaces:interface', keys: { name: 'ethernet-1/1' } });
    // The same entry addressed by a path from the device lines up, now with known keys.
    const statistics = nodeAt(root, parseGnmiPath('/interface[name=ethernet-1/1]/statistics'), registry);
    mergeJson(statistics, { 'out-octets': '5' }, registry);
    expect(collectLeaves(entry).map((leaf) => leaf.path)).toEqual([
      '/srl_nokia-interfaces:interface[name=ethernet-1/1]/name',
      '/srl_nokia-interfaces:interface[name=ethernet-1/1]/admin-state',
      '/srl_nokia-interfaces:interface[name=ethernet-1/1]/statistics/in-octets',
      '/srl_nokia-interfaces:interface[name=ethernet-1/1]/statistics/out-octets',
    ]);
    expect(entry.guessedKeys).toBe(false);
    expect(registry.lookup('/interface')).toEqual(['name']);
    expect(nodeToJson(root)).toMatchObject({ 'srl_nokia-interfaces:interface': [{ name: 'ethernet-1/1' }, { name: 'mgmt0' }] });
  });

  it('guesses compound keys when one leaf is not unique', () => {
    expect(
      guessListKeys([
        { name: 'cpm', type: 'ipv4', entries: 3 },
        { name: 'cpm', type: 'ipv6', entries: 3 },
      ]),
    ).toEqual(['name', 'type']);
    expect(guessListKeys([{ 'sequence-id': 10, action: 'accept' }, { 'sequence-id': 20, action: 'accept' }])).toEqual([
      'sequence-id',
    ]);
  });

  it('turns NETCONF data into the same tree and writes filters that select a node', () => {
    const { document } = { document: new DOMParser().parseFromString(
      '<data xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">' +
        '<interface xmlns="urn:srl:if"><name>ethernet-1/1</name><description>up</description>' +
        '<subinterface><index>0</index><vlan xmlns="urn:srl:vlan"><id>10</id></vlan></subinterface></interface>' +
        '<interface xmlns="urn:srl:if"><name>mgmt0</name></interface>' +
        '<system xmlns="urn:srl:sys"><dns><server>1.1.1.1</server><server>8.8.8.8</server></dns></system>' +
        '</data>',
      'application/xml',
    ) };
    const root = createRoot();
    mergeXml(root, document.documentElement);
    const subinterface = find(root, '0');
    const chain = namespaceChain(root, subinterface);
    expect(subtreeFilterFor(chain)).toBe(
      '<interface xmlns="urn:srl:if"><name>ethernet-1/1</name><subinterface><index>0</index></subinterface></interface>',
    );
    expect(xpathFor(chain)).toBe("/interface[name='ethernet-1/1']/subinterface[index='0']");
    const vlan = find(root, 'vlan');
    expect(subtreeFilterFor(namespaceChain(root, vlan))).toContain('<vlan xmlns="urn:srl:vlan"/>');
    expect(find(root, 'server').kind).toBe('leaf-list');
    expect(editConfigFor(namespaceChain(root, find(root, 'mgmt0')), 'delete')).toContain(
      'nc:operation="delete"',
    );
    const edit = editConfigFor(namespaceChain(root, find(root, 'description')), 'edit');
    expect(edit).toContain('<description>up</description>');
    expect(edit).toContain('<name>ethernet-1/1</name>');
  });
});

describe('NETCONF XML in the renderer', () => {
  it('parses rpc-errors with their details', () => {
    const reply = parseRpcReply(
      '<rpc-reply message-id="3" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><rpc-error>' +
        '<error-type>application</error-type><error-tag>unknown-element</error-tag>' +
        '<error-severity>error</error-severity><error-message>Unknown element</error-message>' +
        '<error-info><bad-element>bogus</bad-element></error-info></rpc-error></rpc-reply>',
    );
    expect(reply).toMatchObject({
      ok: false,
      errors: [{ tag: 'unknown-element', message: 'Unknown element', info: [{ name: 'bad-element', value: 'bogus' }] }],
    });
    expect(parseRpcReply('<rpc-reply><ok/></rpc-reply>')?.ok).toBe(true);
    expect(parseRpcReply('<hello/>')).toBeUndefined();
  });

  it('pretty-prints, checks fragments and unwraps a pasted <rpc>', () => {
    expect(prettyXml('<a><b>1</b><c/></a>')).toBe('<a>\n  <b>1</b>\n  <c/>\n</a>');
    expect(xmlFragmentError('<a/><b/>')).toBeUndefined();
    expect(xmlFragmentError('<a>')).toBeTruthy();
    expect(unwrapRpc('<rpc message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><get/></rpc>')).toBe('<get/>');
  });
});

describe('requests', () => {
  it('builds NETCONF RPCs from the editor state', () => {
    const draft = defaultNetconfDraft();
    expect(netconfRpcBody({ ...draft, operation: 'get-config', source: 'candidate', filterType: 'subtree', filter: '<system/>' })).toBe(
      '<get-config><source><candidate/></source><filter type="subtree"><system/></filter></get-config>',
    );
    expect(netconfRpcBody({ ...draft, operation: 'get', filterType: 'xpath', filter: "/a[b='c']" })).toBe(
      '<get><filter type="xpath" select="/a[b=&apos;c&apos;]"/></get>',
    );
    expect(netconfRpcBody({ ...draft, operation: 'commit', confirmed: true, confirmTimeout: 120 })).toBe(
      '<commit><confirmed/><confirm-timeout>120</confirm-timeout></commit>',
    );
    expect(
      netconfRpcBody({ ...draft, operation: 'edit-config', target: 'candidate', defaultOperation: 'merge', config: '<x/>' }),
    ).toBe('<edit-config><target><candidate/></target><default-operation>merge</default-operation><config><x/></config></edit-config>');
  });

  it('builds gNMI Set and Subscribe messages and catches invalid JSON first', () => {
    const draft = {
      ...defaultGnmiDraft(),
      operation: 'set' as const,
      set: [
        { id: '1', op: 'update' as const, path: '/a', value: '"x"', encoding: 'json_ietf' as const },
        { id: '2', op: 'delete' as const, path: '/b', value: '', encoding: 'json_ietf' as const },
        { id: '3', op: 'replace' as const, path: ' ', value: '', encoding: 'json_ietf' as const },
      ],
    };
    expect(gnmiSetMessage(draft)).toEqual({
      op: 'gnmi-set',
      updates: [{ path: '/a', value: '"x"', encoding: 'json_ietf' }],
      replaces: [],
      deletes: ['/b'],
    });
    expect(gnmiDraftProblem({ ...draft, set: [{ ...draft.set[0]!, value: '{oops' }] })).toMatch(/not valid JSON/);
    const subscribe = {
      ...defaultGnmiDraft(),
      operation: 'subscribe' as const,
      paths: ['/x', ''],
      subscribe: { ...defaultGnmiDraft().subscribe, sampleSeconds: 2.5, suppressRedundant: true, heartbeatSeconds: 60 },
    };
    expect(gnmiSubscribeMessage(subscribe).subscriptions).toEqual([
      { path: '/x', mode: 'sample', sampleIntervalMs: 2500, suppressRedundant: true, heartbeatIntervalMs: 60_000 },
    ]);
    expect(normalizeDraft('gnmi', { operation: 'get', paths: [] }).paths).toEqual(['']);
  });

  it('copies requests as gnmic and ncclient without passwords', () => {
    const profile = { kind: 'gnmi' as const, host: 'leaf1', port: 57400, username: 'admin', tls: 'skip-verify' as const };
    expect(
      gnmicCommand(profile, { ...defaultGnmiDraft(), paths: ['/interface[name=ethernet-1/1]'], dataType: 'state' }, 'json_ietf'),
    ).toBe(
      "gnmic -a leaf1:57400 -u admin -p \"$GNMIC_PASSWORD\" --skip-verify -e json_ietf get --path '/interface[name=ethernet-1/1]' --type state",
    );
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const script = ncclientScript(
      { kind: 'netconf', host: 'leaf1', port: 830, username: 'admin' },
      { ...defaultNetconfDraft(), operation: 'get-config' },
    );
    expect(script).toContain('m.dispatch(to_ele(RPC))');
    expect(script).toContain('password=getpass.getpass()');
  });
});

describe('Set review', () => {
  it('merges updates the way gNMI does, lists by key', () => {
    expect(
      mergeValue(
        { description: 'a', subinterface: [{ index: 0, mtu: 1500 }, { index: 1 }] },
        { 'srl_nokia-if:description': 'b', subinterface: [{ index: 0, mtu: 9000 }, { index: 2 }] },
      ),
    ).toEqual({ description: 'b', subinterface: [{ index: 0, mtu: 9000 }, { index: 1 }, { index: 2 }] });
    const item = { id: '1', op: 'replace' as const, path: '/a', value: '{"x":1}', encoding: 'json_ietf' as const };
    expect(proposedValue(item, { x: 0, y: 1 })).toEqual({ x: 1 });
    expect(proposedValue({ ...item, op: 'delete' }, { x: 0 })).toBeUndefined();
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}');
  });
});

describe('live telemetry table', () => {
  const notification = (seconds: number, value: string): GnmiNotification => ({
    timestamp: String(BigInt(seconds) * 1_000_000_000n),
    updates: [
      {
        path: '/srl_nokia-interfaces:interface[name=e1]/statistics',
        value: { type: 'json_ietf', value: { 'in-octets': value, 'oper-state': seconds > 2 ? 'down' : 'up' } },
      },
    ],
    deletes: [],
  });

  it('flattens container updates into leaves and computes counter rates', () => {
    const table = new LiveTable();
    table.apply([notification(1, '1000')], 100);
    table.apply([notification(2, '3000')], 100);
    table.apply([notification(3, '6000')], 100);
    const octets = table.rows.get('/srl_nokia-interfaces:interface[name=e1]/statistics/in-octets')!;
    expect(octets.counter).toBe(true);
    expect(octets.rate).toBe(3000);
    expect(octets.history).toEqual([2000, 3000]);
    expect(formatRate(octets.path, octets.rate!)).toBe('24 kbit/s');
    const state = table.rows.get('/srl_nokia-interfaces:interface[name=e1]/statistics/oper-state')!;
    expect(state.value).toBe('down');
    expect(state.changedAt).toBeDefined();
    expect(table.leafUpdates).toBe(6);
  });

  it('treats a value that goes down as a gauge', () => {
    const table = new LiveTable();
    table.apply([notification(1, '50')], 0);
    table.apply([notification(2, '40')], 0);
    table.apply([notification(3, '45')], 0);
    const row = table.rows.get('/srl_nokia-interfaces:interface[name=e1]/statistics/in-octets')!;
    expect(row.counter).toBe(false);
    expect(row.rate).toBeUndefined();
    expect(row.history).toEqual([50, 40, 45]);
  });

  it('marks deleted subtrees and keys list entries inside values', () => {
    const table = new LiveTable();
    table.apply([notification(1, '1')], 0);
    table.apply([{ timestamp: '2000000000', updates: [], deletes: ['/srl_nokia-interfaces:interface[name=e1]'] }], 0);
    expect([...table.rows.values()].every((row) => row.deleted)).toBe(true);
    expect(flattenValue('/acl', { filter: [{ name: 'a', hits: 1 }, { name: 'b', hits: 2 }] }, new KeyRegistry())).toEqual([
      ['/acl/filter[name=a]/hits', 1],
      ['/acl/filter[name=b]/hits', 2],
    ]);
    expect(formatSi(1234567)).toBe('1.23 M');
  });
});

describe('gNOI and gNSI tool formats', () => {
  it('reads gNOI permissions written as octal digits', () => {
    expect(permissionString(644)).toBe('rw-r--r--');
    expect(permissionString(755)).toBe('rwxr-xr-x');
    expect(permissionString(0)).toBe('---------');
    expect(permissionString(undefined)).toBe('');
    expect(permissionString(999)).toBe('999');
  });

  it('parses authorized keys and sizes RSA keys', () => {
    const rsa3072 =
      'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDOyztBIThj3WKsWnxGSpcvpfh5AGmTqWJoOqPAC1ZWo4JUSFC0w0uIlV1a9728sz9nFeiIKypvwy63AeWtTjpdQHVe3KKjYFoxvZDbwWoLPOIphyGJBgQA9ukwdBgN1nzwD9KfVZG1+bK5zxB7y5YPquknPaKYng5gVCc7zMDtjBq2PoN29/UjvrD9Iq2jX5PjKP8Ys6xpmenqUAuPUn54nCJ8TXHldnQ+scKqyqIerEF7tNO6Ej8xOMo/n/ChQ9i1AURqoxEKGMVvKUAQJPeKnIaXjrpCdNfu2k2ax7/l2GGqn5GSSmTjfTK8WHMTWzULYRuOwoNamxHTrzkBZ6Nb8Kw8xq4H8pBCplnqJZ/mP61t414s38s/ZavweanbW/eG6/6akXDdtUdZHCGczcVwV4JC/Zt6s/tqz3w8V3w+Z4gR+N9HKwOuTmhyGS1IPjFcIFUbSwWAe3ONz8w31imz+SGLnuJylNENi/P3g6PZM7CFFNQqi27aMz8zaKwDOAE= test@rsa';
    const ed25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFso1Qvz22DNSG95I5vUdco9JYihwF40Irse71T+5YQz me at laptop';
    const parsed = parseAuthorizedKeys(`# team keys\n${rsa3072}\n\n${ed25519}\n`);
    expect(parsed.problem).toBeUndefined();
    expect(parsed.keys.map((key) => [key.keyType, key.comment])).toEqual([
      ['KEY_TYPE_RSA_3072', 'test@rsa'],
      ['KEY_TYPE_ED25519', 'me at laptop'],
    ]);
    expect(parseAuthorizedKeys('ssh-dss AAAAB3NzaC1kc3M=').problem).toMatch(/Line 1: ssh-dss/);
    expect(parseAuthorizedKeys('ssh-ed25519 not*base64').problem).toMatch(/not base64/);
  });

  it('flattens accounting records for the table', () => {
    const grpc = accountingRecord({
      timestamp: { seconds: 1_760_000_000, nanos: 250_000_000 },
      session_info: { user: { identity: 'admin', role: 'admin' }, remote_address: '10.0.0.9', status: 'SESSION_STATUS_OPERATION' },
      grpc_service: { service_type: 'GRPC_SERVICE_TYPE_GNMI', rpc_name: '/gnmi.gNMI/Set', authz: { status: 'AUTHZ_STATUS_PERMIT' } },
    });
    expect(grpc).toMatchObject({
      at: 1_760_000_000_250,
      user: 'admin',
      service: 'gNMI',
      action: '/gnmi.gNMI/Set',
      authz: 'permit',
      remote: '10.0.0.9',
    });
    const cli = accountingRecord({
      session_info: { user: { identity: 'ops' } },
      cmd_service: { service_type: 'CMD_SERVICE_TYPE_CLI', cmd: 'show', cmd_args: ['version'], authz: { status: 'AUTHZ_STATUS_DENY', detail: 'read-only role' } },
    });
    expect(cli).toMatchObject({ service: 'CLI', action: 'show version', authz: 'deny', authzDetail: 'read-only role' });
    expect(cli.key).not.toBe(grpc.key);
  });
});
