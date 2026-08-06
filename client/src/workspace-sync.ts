const CHANNEL_NAME = 'muxus-workspaces-v1';
const STORAGE_KEY = 'muxus-workspaces-sync-v1';
const HEARTBEAT_MS = 5_000;
const PRESENCE_TTL_MS = 20_000;

type WorkspaceSyncMessage =
  | { kind: 'catalog-changed'; senderId: string }
  | { kind: 'presence-request'; senderId: string }
  | { kind: 'presence'; senderId: string; workspaceId?: string }
  | { kind: 'focus'; senderId: string; targetId: string; workspaceId: string }
  | { kind: 'goodbye'; senderId: string };

interface RemotePresence {
  workspaceId?: string;
  lastSeen: number;
}

export interface WorkspaceSyncCallbacks {
  onCatalogChanged: () => void;
  onOpenWindowCountsChanged: (counts: Record<string, number>) => void;
  onWindowFocus: () => void;
  onFocusRequested: () => void;
}

interface SyncEnvelope {
  nonce: string;
  message: WorkspaceSyncMessage;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function isWorkspaceSyncMessage(value: unknown): value is WorkspaceSyncMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (typeof message.kind !== 'string' || typeof message.senderId !== 'string') return false;
  if (message.kind === 'catalog-changed' || message.kind === 'presence-request' || message.kind === 'goodbye') {
    return true;
  }
  if (message.kind === 'presence') {
    return message.workspaceId === undefined || typeof message.workspaceId === 'string';
  }
  return (
    message.kind === 'focus' &&
    typeof message.targetId === 'string' &&
    typeof message.workspaceId === 'string'
  );
}

function defaultChannel(): BroadcastChannel | undefined {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return undefined;
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return undefined;
  }
}

/** One cross-window workspace bus. Each renderer owns exactly one instance. */
export class WorkspaceWindowSync {
  readonly windowId = randomId();
  private readonly remotes = new Map<string, RemotePresence>();
  private channel?: BroadcastChannel;
  private callbacks?: WorkspaceSyncCallbacks;
  private activeWorkspaceId?: string;
  private heartbeat?: ReturnType<typeof setInterval>;
  private started = false;
  private lastCounts = '';

  constructor(private readonly suppliedChannel?: BroadcastChannel) {}

  start(callbacks: WorkspaceSyncCallbacks): void {
    if (this.started) return;
    this.started = true;
    this.callbacks = callbacks;
    this.channel = this.suppliedChannel ?? defaultChannel();
    this.channel?.addEventListener('message', this.handleChannelMessage);
    if (!this.channel && typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorage);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.handleFocus);
      window.addEventListener('pagehide', this.handlePageHide);
    }
    if (this.channel || typeof window !== 'undefined') {
      this.heartbeat = setInterval(() => {
        this.removeStalePresence();
        this.announcePresence();
      }, HEARTBEAT_MS);
    }
    this.post({ kind: 'presence-request', senderId: this.windowId });
    this.announcePresence();
  }

  stop(): void {
    if (!this.started) return;
    this.post({ kind: 'goodbye', senderId: this.windowId });
    this.started = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.channel?.removeEventListener('message', this.handleChannelMessage);
    this.channel?.close();
    this.channel = undefined;
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleStorage);
      window.removeEventListener('focus', this.handleFocus);
      window.removeEventListener('pagehide', this.handlePageHide);
      window.muxusDesktop?.setActiveWorkspace(undefined);
    }
    this.remotes.clear();
    this.publishCounts();
  }

  setActiveWorkspace(workspaceId?: string): void {
    const changed = workspaceId !== this.activeWorkspaceId;
    this.activeWorkspaceId = workspaceId;
    if (typeof window !== 'undefined') {
      window.muxusDesktop?.setActiveWorkspace(workspaceId);
    }
    if (changed) this.announcePresence();
  }

  invalidateCatalog(): void {
    this.post({ kind: 'catalog-changed', senderId: this.windowId });
  }

  requestPresence(): void {
    this.removeStalePresence();
    this.post({ kind: 'presence-request', senderId: this.windowId });
    this.announcePresence();
  }

  focusOpenWorkspace(workspaceId: string): boolean {
    this.removeStalePresence();
    const target = [...this.remotes.entries()]
      .filter(([, presence]) => presence.workspaceId === workspaceId)
      .sort((left, right) => right[1].lastSeen - left[1].lastSeen)[0];
    if (!target) return false;
    this.post({
      kind: 'focus',
      senderId: this.windowId,
      targetId: target[0],
      workspaceId,
    });
    return true;
  }

  openWindowCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const presence of this.remotes.values()) {
      if (!presence.workspaceId) continue;
      counts[presence.workspaceId] = (counts[presence.workspaceId] ?? 0) + 1;
    }
    return counts;
  }

  private readonly handleChannelMessage = (event: MessageEvent<WorkspaceSyncMessage>): void => {
    this.handleMessage(event.data);
  };

  private readonly handleStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const envelope = JSON.parse(event.newValue) as SyncEnvelope;
      this.handleMessage(envelope.message);
    } catch {
      // Ignore malformed or unrelated local-storage traffic.
    }
  };

  private readonly handleFocus = (): void => {
    this.requestPresence();
    this.callbacks?.onWindowFocus();
  };

  private readonly handlePageHide = (): void => {
    this.post({ kind: 'goodbye', senderId: this.windowId });
  };

  private handleMessage(value: unknown): void {
    if (!isWorkspaceSyncMessage(value) || value.senderId === this.windowId) return;
    if (value.kind === 'catalog-changed') {
      this.callbacks?.onCatalogChanged();
      return;
    }
    if (value.kind === 'presence-request') {
      this.announcePresence();
      return;
    }
    if (value.kind === 'goodbye') {
      if (this.remotes.delete(value.senderId)) this.publishCounts();
      return;
    }
    if (value.kind === 'focus') {
      if (value.targetId === this.windowId && value.workspaceId === this.activeWorkspaceId) {
        this.callbacks?.onFocusRequested();
      }
      return;
    }
    this.remotes.set(value.senderId, {
      workspaceId: value.workspaceId,
      lastSeen: Date.now(),
    });
    this.publishCounts();
  }

  private announcePresence(): void {
    this.post({
      kind: 'presence',
      senderId: this.windowId,
      workspaceId: this.activeWorkspaceId,
    });
  }

  private removeStalePresence(): void {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    let changed = false;
    for (const [windowId, presence] of this.remotes) {
      if (presence.lastSeen >= cutoff) continue;
      this.remotes.delete(windowId);
      changed = true;
    }
    if (changed) this.publishCounts();
  }

  private publishCounts(): void {
    const counts = this.openWindowCounts();
    const serialized = JSON.stringify(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
    if (serialized === this.lastCounts) return;
    this.lastCounts = serialized;
    this.callbacks?.onOpenWindowCountsChanged(counts);
  }

  private post(message: WorkspaceSyncMessage): void {
    if (!this.started) return;
    if (this.channel) {
      this.channel.postMessage(message);
      return;
    }
    if (typeof window === 'undefined') return;
    try {
      const envelope: SyncEnvelope = { nonce: randomId(), message };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // Focus refresh remains as the final consistency fallback.
    }
  }
}
