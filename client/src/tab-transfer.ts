import { confirmDiscardRemoteEditors } from './editor/remote-editor-registry.js';
import {
  insertIntoPane,
  useTabsStore,
  type TerminalTab,
  type TransferableTab,
} from './state/tabs.js';
import { findPane } from './state/workspace-layout.js';
import { showToast } from './state/toast.js';
import { terminalHandle } from './terminal/terminal-registry.js';

const CHANNEL_NAME = 'muxus-tab-transfer-v1';
const CLAIM_TIMEOUT_MS = 10_000;
const SOURCE_TTL_MS = 2 * 60_000;

type TransferMessage =
  | { kind: 'claim'; requestId: string; transferId: string }
  | { kind: 'offer'; requestId: string; transferId: string; tab?: TransferableTab }
  | { kind: 'cancel'; transferId: string }
  | { kind: 'complete'; transferId: string };

interface TransferSource {
  tabId: string;
  prepare: () => Promise<boolean>;
  snapshot: () => TransferableTab | undefined;
  cancel: () => void;
  complete: () => void;
  prepared?: Promise<TransferableTab | undefined>;
  expires: ReturnType<typeof setTimeout>;
}

let channel: BroadcastChannel | undefined;
const sources = new Map<string, TransferSource>();
const claims = new Map<
  string,
  {
    resolve: (tab: TransferableTab | undefined) => void;
    retry: ReturnType<typeof setInterval>;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function transferChannel(): BroadcastChannel | undefined {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener('message', (event: MessageEvent<TransferMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.kind === 'claim') {
      const source = sources.get(message.transferId);
      if (!source) return;
      source.prepared ??= (async () => {
        try {
          if (!(await source.prepare())) return undefined;
          return source.snapshot();
        } catch {
          return undefined;
        }
      })();
      void source.prepared.then((tab) => {
        channel?.postMessage({ ...message, kind: 'offer', tab } satisfies TransferMessage);
      });
      return;
    }
    if (message.kind === 'offer') {
      const claim = claims.get(message.requestId);
      if (!claim || message.transferId === '') return;
      clearInterval(claim.retry);
      clearTimeout(claim.timer);
      claims.delete(message.requestId);
      claim.resolve(message.tab);
      return;
    }
    if (message.kind === 'cancel') {
      const source = sources.get(message.transferId);
      if (source) {
        source.cancel();
        source.prepared = undefined;
      }
      return;
    }
    if (message.kind === 'complete') {
      const source = sources.get(message.transferId);
      if (!source) return;
      clearTimeout(source.expires);
      sources.delete(message.transferId);
      source.complete();
    }
  });
  return channel;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function prepareTabTransfer(tabId: string): Promise<boolean> {
  if (!(await confirmDiscardRemoteEditors([tabId]))) return false;
  const handle = terminalHandle(tabId);
  const initial = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  const live = !!initial?.profile && initial.status !== 'closed' && !!initial.terminalId;
  let prepared = false;
  if (live) {
    if (!handle || !(await handle.prepareTransfer())) return false;
    prepared = true;
  }
  await handle?.persistSnapshot();
  const transferable = () => {
    const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
    return (
      !tab ||
      !tab.profile ||
      tab.status === 'closed' ||
      !!tab.terminalId
    );
  };
  if (transferable()) {
    const exists = useTabsStore.getState().tabs.some((tab) => tab.id === tabId);
    if (!exists && prepared) handle?.cancelTransfer();
    return exists;
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      const exists = useTabsStore.getState().tabs.some((tab) => tab.id === tabId);
      if (!exists && prepared) handle?.cancelTransfer();
      resolve(exists);
    };
    const unsubscribe = useTabsStore.subscribe(() => {
      if (transferable()) finish();
    });
    const timer = setTimeout(() => {
      unsubscribe();
      if (prepared) handle?.cancelTransfer();
      resolve(false);
    }, 5_000);
  });
}

/** Register one store tab as the source of a cross-window handoff. */
export function registerTabTransferSource(transferId: string, tabId: string): void {
  registerTabTransferSourceOptions(transferId, {
    tabId,
    prepare: () => prepareTabTransfer(tabId),
    snapshot: () => {
      const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
      if (!tab || (tab.profile && tab.status !== 'closed' && !tab.terminalId)) return undefined;
      const { paneId: _paneId, ...snapshot } = tab;
      return snapshot;
    },
    cancel: () => terminalHandle(tabId)?.cancelTransfer(),
    complete: () => useTabsStore.getState().close(tabId),
  });
}

/** Register a source without putting its profile or credentials in DataTransfer. */
export function registerTabTransferSourceOptions(transferId: string, options: {
  tabId: string;
  prepare: () => Promise<boolean>;
  snapshot: () => TransferableTab | undefined;
  cancel: () => void;
  complete: () => void;
}): void {
  const expires = setTimeout(() => {
    sources.get(transferId)?.cancel();
    sources.delete(transferId);
  }, SOURCE_TTL_MS);
  sources.set(transferId, { ...options, expires });
  transferChannel();
}

/** Retire a token after a move handled entirely inside this renderer. */
export function finishLocalTabTransfer(transferId: string): void {
  const source = sources.get(transferId);
  if (!source) return;
  clearTimeout(source.expires);
  sources.delete(transferId);
  source.cancel();
}

/** Resolve a cross-window token over a same-origin channel. */
export function claimTabTransfer(transferId: string): Promise<TransferableTab | undefined> {
  const transferChannelInstance = transferChannel();
  if (!transferChannelInstance) return Promise.resolve(undefined);
  const requestId = randomId();
  return new Promise((resolve) => {
    const request = () => {
      transferChannelInstance.postMessage({
        kind: 'claim',
        requestId,
        transferId,
      } satisfies TransferMessage);
    };
    const retry = setInterval(request, 250);
    const timer = setTimeout(() => {
      clearInterval(retry);
      claims.delete(requestId);
      transferChannelInstance.postMessage({ kind: 'cancel', transferId } satisfies TransferMessage);
      resolve(undefined);
    }, CLAIM_TIMEOUT_MS);
    claims.set(requestId, { resolve, retry, timer });
    request();
  });
}

export function completeTabTransfer(transferId: string): void {
  transferChannel()?.postMessage({ kind: 'complete', transferId } satisfies TransferMessage);
}

export function adoptTransferredTab(
  tab: TransferableTab,
  paneId: string,
  targetId?: string,
  edge: 'before' | 'after' = 'after',
): boolean {
  const state = useTabsStore.getState();
  if (
    state.tabs.some((candidate) => candidate.id === tab.id) ||
    !findPane(state.root, paneId) ||
    (targetId !== undefined &&
      !state.tabs.some((candidate) => candidate.id === targetId && candidate.paneId === paneId))
  ) {
    return false;
  }
  const adopted = { ...tab, paneId } as TerminalTab;
  useTabsStore.setState({ tabs: insertIntoPane(state.tabs, adopted, paneId, targetId, edge) });
  useTabsStore.getState().activate(tab.id);
  return true;
}

/** Claim and adopt a tab dropped into this renderer. */
export async function receiveTabTransfer(
  transferId: string,
  paneId: string,
  targetId?: string,
  edge: 'before' | 'after' = 'after',
): Promise<void> {
  const offered = await claimTabTransfer(transferId);
  if (!offered) {
    transferChannel()?.postMessage({ kind: 'cancel', transferId } satisfies TransferMessage);
    showToast('warning', 'The tab could not be moved from the other window.');
    return;
  }
  const live = offered.profile !== null && !!offered.terminalId;
  const incoming: TransferableTab = offered.profile
    ? {
        ...offered,
        restored: true,
        connectOnMount: live,
        transferId: live ? transferId : undefined,
      }
    : { ...offered, transferId: undefined };
  if (!adoptTransferredTab(incoming, paneId, targetId, edge)) {
    transferChannel()?.postMessage({ kind: 'cancel', transferId } satisfies TransferMessage);
    showToast('warning', 'A tab with the same identity already exists in this window.');
    return;
  }
  if (!live) completeTabTransfer(transferId);
}
