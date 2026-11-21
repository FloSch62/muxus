import type { HostStatsSample } from './api-types.js';

/**
 * The host monitor: one WebSocket over which the backend pushes statistics
 * of this computer and of every host Muxus is connected to. Readings ride
 * the connections that already exist; the backend dials nothing for it.
 */

export const HOST_MONITOR_WS_PATH = '/ws/host-monitor';

/** How often a host can be read, in milliseconds. */
export const HOST_MONITOR_INTERVALS_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const;
export const DEFAULT_HOST_MONITOR_INTERVAL_MS = 5_000;

/** The row of the computer running Muxus. */
export const LOCAL_MONITOR_HOST_ID = 'local';

/** One row of the monitor: this computer, or a host behind live connections. */
export interface MonitoredHost {
  /** The same for a host across reconnects, while Muxus runs. */
  id: string;
  kind: 'local' | 'ssh';
  /** Live connections to the host, oldest first; empty for this computer. */
  connIds: string[];
  /** What was dialed: a config alias or an ad-hoc "[user@]host[:port]". */
  target?: string;
  /** The saved host, when the connection belongs to one. */
  profileId?: string;
  /** False when the connection ignores ~/.ssh/config. */
  useConfig?: boolean;
  /** Resolved address, port and user; absent for system OpenSSH sessions. */
  host?: string;
  port?: number;
  user?: string;
  /** The session runs the computer's `ssh` program. */
  systemOpenSsh?: boolean;
}

export type HostMonitorClientMessage =
  | {
      op: 'watch';
      intervalMs: number;
      /** Ask hosts with nvidia-smi for their GPUs as well. */
      gpu?: boolean;
      /**
       * Connections to read although no command ran on them yet: the ones
       * the user asked for by name.
       */
      force?: string[];
    }
  /** Ask a host again that was given up on. */
  | { op: 'retry'; id: string };

/**
 * Why a host has no reading. `idle`: not asked, because nothing shows that it
 * runs commands. `unsupported`: asked, and no POSIX shell answered. `error`:
 * the last reading failed and is tried again later.
 */
export type MonitoredHostState = 'idle' | 'unsupported' | 'error';

export type HostMonitorServerMessage =
  | { op: 'hosts'; hosts: MonitoredHost[] }
  | {
      op: 'sample';
      id: string;
      /** Server clock at the reading, for rates when the host reports no uptime. */
      sampledAt: number;
      sample: HostStatsSample;
      /** How long the host took to start answering, in milliseconds. */
      latencyMs?: number;
    }
  | { op: 'state'; id: string; state: MonitoredHostState; message?: string };
