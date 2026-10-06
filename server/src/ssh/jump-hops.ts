import type { Client } from 'ssh2';
import type { SshTransportHealth } from './connection-manager.js';

/**
 * How long a jump hop outlives its last chain. A chain replaced right away —
 * the plain-console redial after a console server dropped the first
 * transport, a reconnect — then rides the same login.
 */
export const JUMP_HOP_IDLE_MS = 5_000;

export interface JumpHopOptions {
  /** Dial-plan identity of the route up to and including this hop. */
  key: string;
  /** What the user wrote for this hop ("bastion"), for status and close reasons. */
  label: string;
  client: Client;
  parent?: JumpHop;
  /** Force-reconnect group that dialed this hop. */
  replacementToken?: string;
  /** Start observing the hop's own keepalive health; returns a stop function. */
  watchHealth: (update: (state: SshTransportHealth) => void) => () => void;
}

/**
 * An authenticated ProxyJump hop shared by every chain routed through it, the
 * way OpenSSH's ControlMaster lets a second `ssh -J` ride the first one's
 * jump connection. A host that refuses a second session on one connection
 * (Cisco IOS and many other appliances) then still gets a dedicated
 * connection for a duplicated tab without another login on the jump host.
 *
 * Each hop holds a reference on the hop before it; a target transport holds
 * one on the last hop of its route. The connection ends shortly after its
 * last reference, and its loss is reported to everything routed through it.
 */
export class JumpHop {
  /** Replaced by a forced fresh route or failed a reuse: never handed out again. */
  superseded = false;
  private refs = 0;
  private ending = false;
  private closed = false;
  private parentReleased = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private healthState: SshTransportHealth = 'healthy';
  private readonly healthListeners = new Set<(state: SshTransportHealth) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly stopHealth: () => void;
  readonly key: string;
  readonly label: string;
  readonly client: Client;
  readonly parent: JumpHop | undefined;
  readonly replacementToken: string | undefined;

  constructor(
    options: JumpHopOptions,
    private readonly idleMs: number,
    private readonly onClosed: (hop: JumpHop) => void,
  ) {
    this.key = options.key;
    this.label = options.label;
    this.client = options.client;
    this.parent = options.parent;
    this.replacementToken = options.replacementToken;
    this.parent?.retain();
    this.stopHealth = options.watchHealth((state) => {
      if (state === this.healthState) return;
      this.healthState = state;
      for (const listener of this.healthListeners) listener(state);
    });
    this.client.on('close', () => this.markClosed());
  }

  /** Live, not winding down, and answering keepalives. */
  get usable(): boolean {
    return !this.closed && !this.ending && !this.superseded && this.healthState === 'healthy';
  }

  get isClosed(): boolean {
    return this.closed;
  }

  health(): SshTransportHealth {
    return this.healthState;
  }

  /** This hop and every hop before it, nearest the target first. */
  route(): JumpHop[] {
    const hops: JumpHop[] = [this];
    for (let hop = this.parent; hop; hop = hop.parent) hops.push(hop);
    return hops;
  }

  retain(): void {
    this.refs += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  release(): void {
    this.refs -= 1;
    if (this.refs > 0 || this.ending || this.closed || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.refs <= 0) this.close();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  onHealth(listener: (state: SshTransportHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Close regardless of references (idle expiry, app shutdown). */
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.ending = true;
    this.client.end();
    this.releaseParent();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.stopHealth();
    this.onClosed(this);
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.healthListeners.clear();
    this.releaseParent();
  }

  private releaseParent(): void {
    if (this.parentReleased) return;
    this.parentReleased = true;
    this.parent?.release();
  }
}

/** Live jump hops by route, for chains dialed after them. */
export class JumpHopRegistry {
  private readonly hops = new Set<JumpHop>();

  constructor(private readonly idleMs = JUMP_HOP_IDLE_MS) {}

  /**
   * Newest usable hop for a route. A force-reconnect request rides only the
   * hops its own gesture dialed, never the ones it is replacing.
   */
  reusable(key: string, freshToken?: string): JumpHop | undefined {
    let found: JumpHop | undefined;
    for (const hop of this.hops) {
      if (hop.key !== key || !hop.usable) continue;
      if (freshToken && hop.replacementToken !== freshToken) continue;
      found = hop;
    }
    return found;
  }

  add(options: JumpHopOptions): JumpHop {
    const { key, replacementToken } = options;
    if (replacementToken) {
      // Routes dialed before a force reconnect keep serving the transports
      // already on them, but no later chain should land on them.
      for (const hop of this.hops) {
        if (hop.key === key && hop.replacementToken !== replacementToken) hop.superseded = true;
      }
    }
    const hop = new JumpHop(options, this.idleMs, (closed) => this.hops.delete(closed));
    this.hops.add(hop);
    return hop;
  }

  closeAll(): void {
    for (const hop of this.hops) hop.close();
  }
}
