import {
  formatGnmiPath,
  parseGnmiPath,
  stripModulePrefix,
  type GnmiNotification,
  type GnmiSessionInfo,
  type ManagementProfile,
  type ManagementResult,
  type ManagementSessionInfo,
  type NetconfSessionInfo,
} from '@muxus/shared';
import { mergeJson, mergeXml, namespaceChain, nodeAt, type DataNode, type KeyRegistry } from './data-tree.js';
import { LiveTable } from './live-table.js';
import {
  defaultGnmiDraft,
  defaultNetconfDraft,
  draftSummary,
  gnmiGetMessage,
  gnmiSetMessage,
  gnmiSubscribeMessage,
  netconfOperationLabel,
  netconfRpcBody,
  type GnmiDraft,
  type ManagementDraft,
  type NetconfDraft,
} from './requests.js';
import {
  ManagementRequestError,
  type LiveSubscription,
  type ManagementConnection,
  type PendingRequest,
} from './session-client.js';
import type { RunRecord, WorkbenchStore } from './workbench-store.js';
import { parseRpcReply, prettyXml, subtreeFilterFor } from './xml.js';

/**
 * The workbench's verbs: run a draft (recording it in the tab's history),
 * cancel, load explorer nodes and keep the NETCONF candidate state current.
 * Views call these; nothing here touches React.
 */

let runCounter = 0;
function runId(): string {
  runCounter += 1;
  return `run${Date.now().toString(36)}${runCounter}`;
}

export function runLabel(draft: ManagementDraft): string {
  if (draft.protocol === 'gnmi') {
    if (draft.operation === 'subscribe') {
      return draft.subscribe.listMode === 'once'
        ? 'Subscribe once'
        : draft.subscribe.listMode === 'poll'
          ? 'Poll'
          : 'Subscribe';
    }
    return draft.operation === 'set' ? 'Set' : 'Get';
  }
  return netconfOperationLabel(draft.operation);
}

/** Explorer requests stop once a response grows past this; the user narrows the path instead. */
const EXPLORER_MAX_BYTES = 24 * 1024 * 1024;

export class WorkbenchController {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly live = new Map<string, LiveSubscription>();
  private candidateCheck = 0;

  constructor(
    readonly store: WorkbenchStore,
    private connection: ManagementConnection | null,
    readonly profile: ManagementProfile,
    readonly info: ManagementSessionInfo | undefined,
  ) {}

  get connected(): boolean {
    return !!this.connection && !this.connection.closed && !!this.info;
  }

  /** The connection went away: running requests end with it, history stays. */
  detach(): void {
    this.connection = null;
    const state = this.store.getState();
    for (const run of state.runs) {
      if (run.status === 'running' || run.status === 'streaming') {
        state.updateRun(run.id, { status: 'error', error: run.error ?? { message: 'The session closed.' } });
      }
    }
    this.pending.clear();
    this.live.clear();
  }

  get gnmiInfo(): GnmiSessionInfo | undefined {
    return this.info?.protocol === 'gnmi' ? this.info : undefined;
  }

  get netconfInfo(): NetconfSessionInfo | undefined {
    return this.info?.protocol === 'netconf' ? this.info : undefined;
  }

  /** The live connection, for gNOI and gNSI tools; null while disconnected. */
  get connectionForTools(): ManagementConnection | null {
    return this.connected ? this.connection : null;
  }

  /**
   * Whether the device offers a gRPC service. Devices without reflection do
   * not say, so everything counts as offered and the device answers for itself.
   */
  hasService(service: string): boolean {
    const services = this.gnmiInfo?.services;
    return services ? services.includes(service) : true;
  }

  hasCapability(fragment: string): boolean {
    return this.netconfInfo?.capabilities.some((capability) => capability.includes(fragment)) ?? false;
  }

  /** Run the editor's draft (or another one) and record it. */
  run(draft: ManagementDraft = this.store.getState().draft, options: { hidden?: boolean } = {}): RunRecord | undefined {
    const connection = this.connection;
    if (!connection || connection.closed) return undefined;
    const record: RunRecord = {
      id: runId(),
      draft: structuredClone(draft),
      label: runLabel(draft),
      summary: draftSummary(draft),
      startedAt: Date.now(),
      status: 'running',
      ...(options.hidden ? { hidden: true } : {}),
    };
    const state = this.store.getState();
    state.addRun(record);
    if (draft.protocol === 'gnmi' && draft.operation === 'subscribe') {
      this.startSubscription(record, draft, connection);
      return record;
    }
    const commitId =
      draft.protocol === 'gnmi' && draft.operation === 'set' && draft.confirmSeconds ? `muxus-${record.id}` : undefined;
    let pending: PendingRequest;
    try {
      pending =
        draft.protocol === 'gnmi'
          ? connection.request(draft.operation === 'set' ? gnmiSetMessage(draft, commitId) : gnmiGetMessage(draft))
          : connection.request({ op: 'netconf-rpc', xml: netconfRpcBody(draft) });
    } catch (err) {
      state.updateRun(record.id, { status: 'error', error: { message: (err as Error).message } });
      return record;
    }
    this.pending.set(record.id, pending);
    void pending.promise.then(
      (outcome) => {
        this.pending.delete(record.id);
        this.store.getState().updateRun(record.id, {
          status: 'ok',
          result: outcome.result,
          durationMs: outcome.durationMs,
          bytes: outcome.bytes,
        });
        if (draft.protocol === 'netconf') this.afterNetconf(draft, outcome.result);
        if (draft.protocol === 'gnmi' && outcome.result.op === 'gnmi-get') this.learnKeys(outcome.result.notifications);
        if (draft.protocol === 'gnmi' && outcome.result.op === 'gnmi-set') {
          if (commitId && draft.confirmSeconds) {
            this.store.setState({ confirmDeadline: Date.now() + draft.confirmSeconds * 1000, commitId });
          }
          this.refreshExplorer(draft.set.map((item) => item.path.trim()).filter(Boolean));
        }
      },
      (err: unknown) => {
        this.pending.delete(record.id);
        const error = err instanceof ManagementRequestError ? err.error : { message: String(err) };
        this.store.getState().updateRun(record.id, {
          status: error.cancelled ? 'cancelled' : 'error',
          error,
          ...(err instanceof ManagementRequestError ? { durationMs: err.durationMs } : {}),
        });
      },
    );
    return record;
  }

  /** Confirm a gNMI commit-confirmed Set, or roll it back before its timer does. */
  finishGnmiCommit(action: 'confirm' | 'cancel'): void {
    const connection = this.connection;
    const { commitId, confirmDeadline } = this.store.getState();
    if (!connection || connection.closed || !commitId) return;
    const draft: GnmiDraft = { ...defaultGnmiDraft(), operation: 'set', set: [] };
    const record: RunRecord = {
      id: runId(),
      draft,
      label: action === 'confirm' ? 'Confirm commit' : 'Roll back',
      summary: commitId,
      startedAt: Date.now(),
      status: 'running',
    };
    this.store.getState().addRun(record);
    const pending = connection.request({ op: 'gnmi-set', updates: [], replaces: [], deletes: [], commit: { action, id: commitId } });
    void pending.promise.then(
      (outcome) => {
        this.store.getState().updateRun(record.id, {
          status: 'ok',
          result: outcome.result,
          durationMs: outcome.durationMs,
          bytes: outcome.bytes,
        });
        this.store.setState({ confirmDeadline: undefined, commitId: undefined });
        if (action === 'cancel') this.refreshExplorer();
      },
      (err: unknown) => {
        const error = err instanceof ManagementRequestError ? err.error : { message: String(err) };
        this.store.getState().updateRun(record.id, { status: 'error', error });
        // Past the deadline the device rolled back on its own.
        if (confirmDeadline !== undefined && Date.now() > confirmDeadline) {
          this.store.setState({ confirmDeadline: undefined, commitId: undefined });
        }
      },
    );
  }

  /** Run and wait, outside of history: explorer loads, candidate checks, review fetches. */
  async request(draft: ManagementDraft, maxBytes?: number): Promise<ManagementResult> {
    const connection = this.connection;
    if (!connection || connection.closed) throw new Error('Not connected.');
    if (draft.protocol === 'gnmi') {
      const message = { ...gnmiGetMessage(draft), ...(maxBytes ? { maxBytes } : {}) };
      return (await connection.request(draft.operation === 'set' ? gnmiSetMessage(draft) : message).promise).result;
    }
    return (await connection.request({ op: 'netconf-rpc', xml: netconfRpcBody(draft) }).promise).result;
  }

  private startSubscription(record: RunRecord, draft: GnmiDraft, connection: ManagementConnection): void {
    const table = new LiveTable();
    const started = performance.now();
    this.store.getState().updateRun(record.id, { live: table, status: 'streaming' });
    const subscription = connection.subscribe(gnmiSubscribeMessage(draft), {
      notifications: (notifications, bytes) => table.apply(notifications, bytes),
      sync: () => {
        table.markSynced();
        this.store.getState().updateRun(record.id, { synced: true });
        if (draft.subscribe.listMode === 'once') {
          // ONCE ends right after the sync; keep the duration for the header.
          this.store.getState().updateRun(record.id, { durationMs: Math.round(performance.now() - started) });
        }
      },
      end: (error) => {
        this.live.delete(record.id);
        const current = this.store.getState().runs.find((run) => run.id === record.id);
        this.store.getState().updateRun(record.id, {
          status: error && !error.cancelled ? 'error' : current?.status === 'cancelled' ? 'cancelled' : 'ok',
          ...(error && !error.cancelled ? { error } : {}),
          durationMs: current?.durationMs ?? Math.round(performance.now() - started),
          bytes: table.bytes,
        });
      },
    });
    this.live.set(record.id, subscription);
  }

  poll(runId: string): void {
    this.live.get(runId)?.poll();
  }

  cancel(runId: string): void {
    const pending = this.pending.get(runId);
    if (pending) {
      pending.cancel();
      return;
    }
    const subscription = this.live.get(runId);
    if (subscription) {
      this.store.getState().updateRun(runId, { status: 'cancelled' });
      subscription.cancel();
    }
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys(), ...this.live.keys()]) this.cancel(id);
  }

  private learnKeys(notifications: readonly GnmiNotification[]): void {
    const registry = this.store.getState().explorer.registry;
    for (const notification of notifications) {
      for (const update of notification.updates) {
        try {
          registry.learn(parseGnmiPath(update.path));
        } catch {
          /* unparseable paths teach nothing */
        }
      }
    }
  }

  // Explorer

  /** Fetch the children of an explorer node (the root when `node` is the tree root). */
  async loadNode(node: DataNode): Promise<void> {
    const state = this.store.getState();
    const explorer = state.explorer;
    if (!this.connected || explorer.loading.has(node.id)) return;
    state.touchExplorer((current) => {
      current.loading.add(node.id);
      current.errors.delete(node.id);
    });
    try {
      if (this.profile.kind === 'gnmi') await this.loadGnmiNode(node);
      else await this.loadNetconfNode(node);
      state.touchExplorer((current) => {
        node.loaded = true;
        current.loading.delete(node.id);
        current.expanded.add(node.id);
      });
    } catch (err) {
      const message = err instanceof ManagementRequestError ? err.error.message : (err as Error).message;
      state.touchExplorer((current) => {
        current.loading.delete(node.id);
        current.errors.set(node.id, message);
      });
    }
  }

  private async loadGnmiNode(node: DataNode): Promise<void> {
    const explorer = this.store.getState().explorer;
    const path = formatGnmiPath(node.path);
    const base: GnmiDraft = {
      ...defaultGnmiDraft(),
      paths: [path],
      dataType: explorer.scope === 'config' ? 'config' : 'all',
      depth: explorer.noDepth ? undefined : 2,
    };
    let result: ManagementResult;
    try {
      result = await this.request(base, EXPLORER_MAX_BYTES);
    } catch (err) {
      // Devices without the depth extension reject it; browse whole subtrees instead.
      if (
        !explorer.noDepth &&
        err instanceof ManagementRequestError &&
        /depth|extension|unimplemented|not supported/i.test(`${err.error.code ?? ''} ${err.error.message}`)
      ) {
        explorer.noDepth = true;
        result = await this.request({ ...base, depth: undefined }, EXPLORER_MAX_BYTES);
      } else {
        throw err;
      }
    }
    if (result.op !== 'gnmi-get') return;
    const notifications = result.notifications;
    this.learnKeys(notifications);
    const merge = () => {
      // A depth-limited reply only lists the next level: forget what was there.
      node.children = [];
      for (const notification of notifications) {
        for (const update of notification.updates) {
          const target = nodeAt(explorer.root, parseGnmiPath(update.path), explorer.registry);
          mergeJson(target, update.value.value, explorer.registry);
        }
      }
    };
    merge();
    // JSON does not say which leaves key a list. Ask the device for keyed
    // paths of the lists it has not shown us yet, then lay the data out again.
    const unkeyed = unkeyedLists(node, explorer.registry).slice(0, 8);
    if (unkeyed.length === 0) return;
    const learned = await Promise.all(unkeyed.map((list) => this.discoverKeys(list)));
    if (learned.some(Boolean)) merge();
  }

  /** Learn a list's key leaves from the paths a one-shot subscription returns. */
  private async discoverKeys(list: DataNode): Promise<boolean> {
    const connection = this.connection;
    const entry = list.children[0];
    const leaf = entry?.children.find((child) => child.kind === 'leaf');
    if (!connection || connection.closed || !leaf) return false;
    const registry = this.store.getState().explorer.registry;
    const schema = schemaPathOf(list);
    const path = `${formatGnmiPath(list.path)}/${stripModulePrefix(leaf.name)}`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (learned: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        subscription.cancel();
        resolve(learned);
      };
      const subscription = connection.subscribe(
        { op: 'gnmi-subscribe', mode: 'once', subscriptions: [{ path, mode: 'target-defined' }] },
        {
          notifications: (notifications) => {
            this.learnKeys(notifications);
            if (registry.lookup(schema)) finish(true);
          },
          sync: () => finish(!!registry.lookup(schema)),
          end: () => finish(!!registry.lookup(schema)),
        },
      );
      const timer = setTimeout(() => finish(false), 8000);
    });
  }

  private async loadNetconfNode(node: DataNode): Promise<void> {
    const explorer = this.store.getState().explorer;
    const root = node.kind === 'root';
    const chain = root ? [] : namespaceChain(explorer.root, node);
    const filter = root ? '' : subtreeFilterFor(chain);
    const config = explorer.scope === 'config';
    const draft: NetconfDraft = {
      ...defaultNetconfDraft(),
      operation: config || root ? 'get-config' : 'get',
      filterType: filter ? 'subtree' : 'none',
      filter,
    };
    const result = await this.request(draft);
    if (result.op !== 'netconf-rpc') return;
    const reply = parseRpcReply(result.xml);
    if (!reply) throw new Error('The device sent something that is not an rpc-reply.');
    if (reply.errors.length) throw new Error(reply.errors.map((error) => error.message ?? error.tag).join('; '));
    if (!reply.data) return;
    if (root) {
      explorer.root.children = [];
      mergeXml(explorer.root, reply.data);
      // With configuration loaded whole, every node is already complete.
      if (config) markLoaded(explorer.root);
      return;
    }
    // The reply repeats the ancestors; merge from the top so they line up.
    const parentChildren = node.children;
    node.children = [];
    mergeXml(explorer.root, reply.data);
    if (node.children.length === 0) node.children = parentChildren;
    markLoaded(node);
  }

  /**
   * Show what a change did: reload the explorer where it touched the data.
   * NETCONF configuration loads whole, so the root reloads; for gNMI the
   * nearest loaded node above each changed path does.
   */
  refreshExplorer(paths: readonly string[] = []): void {
    const explorer = this.store.getState().explorer;
    if (!explorer.root.loaded) return;
    if (this.profile.kind === 'netconf' || paths.length === 0) {
      void this.loadNode(explorer.root);
      return;
    }
    const targets = new Set<DataNode>();
    for (const text of paths) {
      let path;
      try {
        path = parseGnmiPath(text);
      } catch {
        continue;
      }
      let node: DataNode = explorer.root;
      let deepest: DataNode = explorer.root;
      for (const elem of path.elems) {
        const name = stripModulePrefix(elem.name);
        const next: DataNode | undefined = node.children.find(
          (child) => child.kind !== 'entry' && stripModulePrefix(child.name) === name,
        );
        const entry = next && elem.keys
          ? next.children.find((candidate) =>
              Object.entries(elem.keys ?? {}).every(([key, value]) => candidate.keys?.[key] === value),
            )
          : next;
        if (!entry) break;
        node = entry;
        if (entry.loaded) deepest = entry;
      }
      targets.add(deepest);
    }
    for (const target of targets) void this.loadNode(target);
  }

  // NETCONF bookkeeping

  private afterNetconf(draft: NetconfDraft, result: ManagementResult): void {
    if (result.op !== 'netconf-rpc') return;
    const reply = parseRpcReply(result.xml);
    const ok = !!reply && reply.errors.length === 0;
    const state = this.store.getState();
    if (ok && draft.operation === 'lock' && !state.locks.includes(draft.target)) {
      this.store.setState({ locks: [...state.locks, draft.target] });
    }
    if (ok && draft.operation === 'unlock') {
      this.store.setState({ locks: state.locks.filter((lock) => lock !== draft.target) });
    }
    if (ok && draft.operation === 'commit') {
      this.store.setState({
        confirmDeadline: draft.confirmed ? Date.now() + Math.max(1, draft.confirmTimeout) * 1000 : undefined,
      });
    }
    if (ok && draft.operation === 'cancel-commit') this.store.setState({ confirmDeadline: undefined });
    const changesRunning =
      draft.operation === 'commit' ||
      draft.operation === 'cancel-commit' ||
      ((draft.operation === 'edit-config' || draft.operation === 'copy-config') && draft.target === 'running');
    if (ok && changesRunning) this.refreshExplorer();
    const touchesCandidate =
      (draft.operation === 'edit-config' && draft.target === 'candidate') ||
      draft.operation === 'commit' ||
      draft.operation === 'discard-changes' ||
      draft.operation === 'cancel-commit' ||
      (draft.operation === 'copy-config' && draft.target === 'candidate');
    if (touchesCandidate) void this.checkCandidate();
  }

  /** Compare candidate with running and remember whether they differ. */
  async checkCandidate(): Promise<{ running: string; candidate: string } | undefined> {
    if (!this.hasCapability(':candidate')) return undefined;
    const ticket = ++this.candidateCheck;
    const state = this.store.getState();
    this.store.setState({ candidate: { ...(state.candidate ?? { dirty: false }), checking: true } });
    const fetch = async (source: 'running' | 'candidate') => {
      const result = await this.request({ ...defaultNetconfDraft(), source, filterType: 'none' });
      if (result.op !== 'netconf-rpc') return '';
      const reply = parseRpcReply(result.xml);
      if (reply?.errors.length) throw new Error(reply.errors[0]?.message ?? 'get-config failed');
      return reply?.data ? prettyXml(new XMLSerializer().serializeToString(reply.data)) : '';
    };
    try {
      const [running, candidate] = await Promise.all([fetch('running'), fetch('candidate')]);
      if (ticket === this.candidateCheck) {
        this.store.setState({ candidate: { dirty: running !== candidate, checking: false, checkedAt: Date.now() } });
      }
      return { running, candidate };
    } catch (err) {
      if (ticket === this.candidateCheck) {
        this.store.setState({
          candidate: { dirty: false, checking: false, checkedAt: Date.now(), error: (err as Error).message },
        });
      }
      return undefined;
    }
  }
}

function schemaPathOf(node: DataNode): string {
  return `/${node.path.elems.map((elem) => stripModulePrefix(elem.name)).join('/')}`;
}

/** Lists below `node`, within the levels a depth-limited reply shows, whose keys are only guessed. */
function unkeyedLists(node: DataNode, registry: KeyRegistry, depth = 0, out: DataNode[] = []): DataNode[] {
  if (depth > 3) return out;
  for (const child of node.children) {
    if (child.kind === 'list') {
      if (child.children.some((entry) => entry.guessedKeys) && !registry.lookup(schemaPathOf(child))) out.push(child);
      for (const entry of child.children) unkeyedLists(entry, registry, depth + 2, out);
    } else if (child.kind === 'container') {
      unkeyedLists(child, registry, depth + 1, out);
    }
  }
  return out;
}

function markLoaded(node: DataNode): void {
  node.loaded = true;
  for (const child of node.children) markLoaded(child);
}
