import type {
  GnmiDataType,
  GnmiEncoding,
  GnmiSubscriptionListMode,
  GnmiSubscriptionMode,
  ManagementClientMessage,
} from '@muxus/shared';
import { escapeXml, unwrapRpc } from './xml.js';

/**
 * What the request editor holds. These drafts are also what the library
 * stores and what history entries replay, so they keep everything needed
 * to run the request again.
 */

export type GnmiOperation = 'get' | 'set' | 'subscribe';

export type GnmiSetOp = 'update' | 'replace' | 'delete';

export interface GnmiSetItem {
  id: string;
  op: GnmiSetOp;
  path: string;
  /** JSON text (json_ietf/json) or raw text (ascii). */
  value: string;
  encoding: 'json_ietf' | 'json' | 'ascii';
}

export interface GnmiDraft {
  protocol: 'gnmi';
  operation: GnmiOperation;
  /** Get and Subscribe paths. */
  paths: string[];
  prefix: string;
  dataType: GnmiDataType;
  /** Absent: the session's encoding. */
  encoding?: GnmiEncoding;
  depth?: number;
  set: GnmiSetItem[];
  /** Ask for automatic rollback unless confirmed (gNMI commit-confirmed extension). */
  confirmSeconds?: number;
  subscribe: {
    listMode: GnmiSubscriptionListMode;
    mode: GnmiSubscriptionMode;
    sampleSeconds: number;
    suppressRedundant: boolean;
    heartbeatSeconds?: number;
    updatesOnly: boolean;
  };
}

export type NetconfOperation =
  | 'get'
  | 'get-config'
  | 'edit-config'
  | 'lock'
  | 'unlock'
  | 'validate'
  | 'commit'
  | 'discard-changes'
  | 'cancel-commit'
  | 'copy-config'
  | 'delete-config'
  | 'get-schema'
  | 'kill-session'
  | 'create-subscription'
  | 'custom';

export type Datastore = 'running' | 'candidate' | 'startup';

export interface NetconfDraft {
  protocol: 'netconf';
  operation: NetconfOperation;
  source: Datastore;
  target: Datastore;
  filterType: 'subtree' | 'xpath' | 'none';
  /** Subtree filter XML, or an XPath expression. */
  filter: string;
  /** edit-config <config> content. */
  config: string;
  defaultOperation: '' | 'merge' | 'replace' | 'none';
  testOption: '' | 'test-then-set' | 'set' | 'test-only';
  errorOption: '' | 'stop-on-error' | 'continue-on-error' | 'rollback-on-error';
  withDefaults: '' | 'report-all' | 'report-all-tagged' | 'trim' | 'explicit';
  confirmed: boolean;
  confirmTimeout: number;
  persist: string;
  schemaIdentifier: string;
  schemaVersion: string;
  sessionId: string;
  /** Custom RPC body. */
  rpc: string;
}

export type ManagementDraft = GnmiDraft | NetconfDraft;

let itemCounter = 0;
export function newItemId(): string {
  itemCounter += 1;
  return `i${Date.now().toString(36)}${itemCounter}`;
}

export function defaultGnmiDraft(): GnmiDraft {
  return {
    protocol: 'gnmi',
    operation: 'get',
    paths: [''],
    prefix: '',
    dataType: 'all',
    set: [{ id: newItemId(), op: 'update', path: '', value: '', encoding: 'json_ietf' }],
    subscribe: {
      listMode: 'stream',
      mode: 'sample',
      sampleSeconds: 10,
      suppressRedundant: false,
      updatesOnly: false,
    },
  };
}

export function defaultNetconfDraft(): NetconfDraft {
  return {
    protocol: 'netconf',
    operation: 'get-config',
    source: 'running',
    target: 'candidate',
    filterType: 'subtree',
    filter: '',
    config: '',
    defaultOperation: '',
    testOption: '',
    errorOption: '',
    withDefaults: '',
    confirmed: false,
    confirmTimeout: 600,
    persist: '',
    schemaIdentifier: '',
    schemaVersion: '',
    sessionId: '',
    rpc: '',
  };
}

/** Bring a stored draft up to the current shape (the library keeps old ones). */
export function normalizeDraft(protocol: 'gnmi', stored: Record<string, unknown>): GnmiDraft;
export function normalizeDraft(protocol: 'netconf', stored: Record<string, unknown>): NetconfDraft;
export function normalizeDraft(protocol: 'gnmi' | 'netconf', stored: Record<string, unknown>): ManagementDraft {
  if (protocol === 'gnmi') {
    const base = defaultGnmiDraft();
    const draft = { ...base, ...stored, protocol: 'gnmi' } as GnmiDraft;
    draft.subscribe = { ...base.subscribe, ...(stored.subscribe as object | undefined) };
    if (!Array.isArray(draft.paths) || draft.paths.length === 0) draft.paths = [''];
    if (!Array.isArray(draft.set) || draft.set.length === 0) draft.set = base.set;
    return draft;
  }
  return { ...defaultNetconfDraft(), ...stored, protocol: 'netconf' } as NetconfDraft;
}

export function nonEmptyPaths(paths: readonly string[]): string[] {
  return paths.map((path) => path.trim()).filter(Boolean);
}

type GnmiWire =
  | Omit<Extract<ManagementClientMessage, { op: 'gnmi-get' }>, 'id'>
  | Omit<Extract<ManagementClientMessage, { op: 'gnmi-set' }>, 'id'>
  | Omit<Extract<ManagementClientMessage, { op: 'gnmi-subscribe' }>, 'id'>;

export function gnmiGetMessage(draft: GnmiDraft): Omit<Extract<ManagementClientMessage, { op: 'gnmi-get' }>, 'id'> {
  const paths = nonEmptyPaths(draft.paths);
  return {
    op: 'gnmi-get',
    paths: paths.length ? paths : ['/'],
    type: draft.dataType,
    ...(draft.prefix.trim() ? { prefix: draft.prefix.trim() } : {}),
    ...(draft.encoding ? { encoding: draft.encoding } : {}),
    ...(draft.depth ? { depth: draft.depth } : {}),
  };
}

/** `commitId` turns on the commit-confirmed extension when the draft asks for a rollback timer. */
export function gnmiSetMessage(
  draft: GnmiDraft,
  commitId?: string,
): Omit<Extract<ManagementClientMessage, { op: 'gnmi-set' }>, 'id'> {
  const items = draft.set.filter((item) => item.path.trim());
  const value = (item: GnmiSetItem) => ({ path: item.path.trim(), value: item.value, encoding: item.encoding });
  return {
    op: 'gnmi-set',
    ...(draft.prefix.trim() ? { prefix: draft.prefix.trim() } : {}),
    updates: items.filter((item) => item.op === 'update').map(value),
    replaces: items.filter((item) => item.op === 'replace').map(value),
    deletes: items.filter((item) => item.op === 'delete').map((item) => item.path.trim()),
    ...(commitId && draft.confirmSeconds
      ? { commit: { action: 'commit' as const, id: commitId, rollbackSeconds: draft.confirmSeconds } }
      : {}),
  };
}

export function gnmiSubscribeMessage(
  draft: GnmiDraft,
): Omit<Extract<ManagementClientMessage, { op: 'gnmi-subscribe' }>, 'id'> {
  const sub = draft.subscribe;
  return {
    op: 'gnmi-subscribe',
    mode: sub.listMode,
    ...(draft.prefix.trim() ? { prefix: draft.prefix.trim() } : {}),
    ...(draft.encoding ? { encoding: draft.encoding } : {}),
    ...(sub.updatesOnly ? { updatesOnly: true } : {}),
    subscriptions: nonEmptyPaths(draft.paths).map((path) => ({
      path,
      mode: sub.listMode === 'stream' ? sub.mode : 'target-defined',
      ...(sub.listMode === 'stream' && sub.mode === 'sample'
        ? { sampleIntervalMs: Math.max(1, Math.round(sub.sampleSeconds * 1000)) }
        : {}),
      ...(sub.listMode === 'stream' && sub.suppressRedundant ? { suppressRedundant: true } : {}),
      ...(sub.listMode === 'stream' && sub.heartbeatSeconds
        ? { heartbeatIntervalMs: Math.round(sub.heartbeatSeconds * 1000) }
        : {}),
    })),
  };
}

export function gnmiMessage(draft: GnmiDraft): GnmiWire {
  if (draft.operation === 'set') return gnmiSetMessage(draft);
  if (draft.operation === 'subscribe') return gnmiSubscribeMessage(draft);
  return gnmiGetMessage(draft);
}

/** Why the draft cannot run yet, if it cannot. */
export function gnmiDraftProblem(draft: GnmiDraft): string | undefined {
  if (draft.operation === 'set') {
    const items = draft.set.filter((item) => item.path.trim());
    if (items.length === 0) return 'Add a path to change.';
    for (const item of items) {
      if (item.op === 'delete' || item.encoding === 'ascii') continue;
      try {
        JSON.parse(item.value);
      } catch {
        return `The value for ${item.path.trim()} is not valid JSON${item.value.trim() ? '' : ' (it is empty)'}.`;
      }
    }
    return undefined;
  }
  if (draft.operation === 'subscribe' && nonEmptyPaths(draft.paths).length === 0) {
    return 'Add a path to subscribe to.';
  }
  return undefined;
}

// NETCONF

function datastore(name: Datastore): string {
  return `<${name}/>`;
}

function filterXml(draft: NetconfDraft): string {
  if (draft.filterType === 'none' || !draft.filter.trim()) return '';
  if (draft.filterType === 'xpath') return `<filter type="xpath" select="${escapeXml(draft.filter.trim())}"/>`;
  return `<filter type="subtree">${draft.filter.trim()}</filter>`;
}

function withDefaultsXml(draft: NetconfDraft): string {
  return draft.withDefaults
    ? `<with-defaults xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults">${draft.withDefaults}</with-defaults>`
    : '';
}

/** The operation element(s) the <rpc> wraps. */
export function netconfRpcBody(draft: NetconfDraft): string {
  switch (draft.operation) {
    case 'get':
      return `<get>${filterXml(draft)}${withDefaultsXml(draft)}</get>`;
    case 'get-config':
      return `<get-config><source>${datastore(draft.source)}</source>${filterXml(draft)}${withDefaultsXml(draft)}</get-config>`;
    case 'edit-config':
      return (
        `<edit-config><target>${datastore(draft.target)}</target>` +
        (draft.defaultOperation ? `<default-operation>${draft.defaultOperation}</default-operation>` : '') +
        (draft.testOption ? `<test-option>${draft.testOption}</test-option>` : '') +
        (draft.errorOption ? `<error-option>${draft.errorOption}</error-option>` : '') +
        `<config>${draft.config.trim()}</config></edit-config>`
      );
    case 'lock':
      return `<lock><target>${datastore(draft.target)}</target></lock>`;
    case 'unlock':
      return `<unlock><target>${datastore(draft.target)}</target></unlock>`;
    case 'validate':
      return `<validate><source>${datastore(draft.source)}</source></validate>`;
    case 'commit':
      return draft.confirmed
        ? `<commit><confirmed/><confirm-timeout>${Math.max(1, Math.round(draft.confirmTimeout))}</confirm-timeout>` +
            (draft.persist.trim() ? `<persist>${escapeXml(draft.persist.trim())}</persist>` : '') +
            '</commit>'
        : draft.persist.trim()
          ? `<commit><persist-id>${escapeXml(draft.persist.trim())}</persist-id></commit>`
          : '<commit/>';
    case 'discard-changes':
      return '<discard-changes/>';
    case 'cancel-commit':
      return draft.persist.trim()
        ? `<cancel-commit><persist-id>${escapeXml(draft.persist.trim())}</persist-id></cancel-commit>`
        : '<cancel-commit/>';
    case 'copy-config':
      return `<copy-config><target>${datastore(draft.target)}</target><source>${datastore(draft.source)}</source></copy-config>`;
    case 'delete-config':
      return `<delete-config><target>${datastore(draft.target)}</target></delete-config>`;
    case 'get-schema':
      return (
        '<get-schema xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring">' +
        `<identifier>${escapeXml(draft.schemaIdentifier.trim())}</identifier>` +
        (draft.schemaVersion.trim() ? `<version>${escapeXml(draft.schemaVersion.trim())}</version>` : '') +
        '<format>yang</format></get-schema>'
      );
    case 'kill-session':
      return `<kill-session><session-id>${escapeXml(draft.sessionId.trim())}</session-id></kill-session>`;
    case 'create-subscription':
      return `<create-subscription xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0">${
        draft.filter.trim() && draft.filterType === 'subtree' ? `<filter type="subtree">${draft.filter.trim()}</filter>` : ''
      }</create-subscription>`;
    case 'custom':
      return unwrapRpc(draft.rpc.trim());
  }
}

export function netconfDraftProblem(draft: NetconfDraft): string | undefined {
  if (draft.operation === 'edit-config' && !draft.config.trim()) return 'Enter the configuration to apply.';
  if (draft.operation === 'get-schema' && !draft.schemaIdentifier.trim()) return 'Enter the module name.';
  if (draft.operation === 'kill-session' && !/^\d+$/.test(draft.sessionId.trim())) return 'Enter a session id.';
  if (draft.operation === 'custom' && !draft.rpc.trim()) return 'Enter the RPC to send.';
  return undefined;
}

/** Operations that change device state, which run behind a confirmation in shared sessions. */
export function netconfChangesState(operation: NetconfOperation): boolean {
  return ['edit-config', 'commit', 'copy-config', 'delete-config', 'discard-changes', 'kill-session'].includes(
    operation,
  );
}

export const NETCONF_OPERATION_GROUPS: ReadonlyArray<{
  label: string;
  operations: ReadonlyArray<{ value: NetconfOperation; label: string; description: string }>;
}> = [
  {
    label: 'Retrieve',
    operations: [
      { value: 'get-config', label: 'get-config', description: 'Configuration from a datastore' },
      { value: 'get', label: 'get', description: 'Running configuration and state' },
      { value: 'get-schema', label: 'get-schema', description: 'A YANG module from the device' },
    ],
  },
  {
    label: 'Change',
    operations: [
      { value: 'edit-config', label: 'edit-config', description: 'Apply configuration to a datastore' },
      { value: 'copy-config', label: 'copy-config', description: 'Replace one datastore with another' },
      { value: 'delete-config', label: 'delete-config', description: 'Delete a datastore' },
    ],
  },
  {
    label: 'Candidate',
    operations: [
      { value: 'validate', label: 'validate', description: 'Check a datastore without applying it' },
      { value: 'commit', label: 'commit', description: 'Make the candidate the running configuration' },
      { value: 'discard-changes', label: 'discard-changes', description: 'Reset the candidate to running' },
      { value: 'cancel-commit', label: 'cancel-commit', description: 'Roll back a confirmed commit' },
      { value: 'lock', label: 'lock', description: 'Keep other sessions out of a datastore' },
      { value: 'unlock', label: 'unlock', description: 'Release a lock' },
    ],
  },
  {
    label: 'Session',
    operations: [
      { value: 'create-subscription', label: 'create-subscription', description: 'Receive event notifications' },
      { value: 'kill-session', label: 'kill-session', description: 'End another NETCONF session' },
      { value: 'custom', label: 'Custom RPC', description: 'Any RPC, written by hand' },
    ],
  },
];

export function netconfOperationLabel(operation: NetconfOperation): string {
  for (const group of NETCONF_OPERATION_GROUPS) {
    const match = group.operations.find((candidate) => candidate.value === operation);
    if (match) return match.label;
  }
  return operation;
}

/** One-line summary for history and library rows. */
export function draftSummary(draft: ManagementDraft): string {
  if (draft.protocol === 'gnmi') {
    if (draft.operation === 'set') {
      const items = draft.set.filter((item) => item.path.trim());
      return items.map((item) => `${item.op} ${item.path.trim()}`).join(', ') || 'Set';
    }
    return nonEmptyPaths(draft.paths).join(', ') || '/';
  }
  switch (draft.operation) {
    case 'get':
    case 'get-config':
      return draft.filter.trim() ? (draft.filterType === 'xpath' ? draft.filter.trim() : 'with filter') : 'everything';
    case 'get-schema':
      return draft.schemaIdentifier;
    case 'edit-config':
    case 'lock':
    case 'unlock':
    case 'delete-config':
      return draft.target;
    case 'copy-config':
      return `${draft.source} → ${draft.target}`;
    default:
      return '';
  }
}
