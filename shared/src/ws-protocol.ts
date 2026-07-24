import { z } from 'zod';

/** Fixed subprotocol selected by the server for terminal sockets. */
export const TERMINAL_WS_PROTOCOL = 'muxus.terminal.v1';
/** Authentication is offered as a non-selected subprotocol so it stays out of request URLs. */
export const TERMINAL_WS_AUTH_PREFIX = 'muxus.auth.';

/** Protocols offered by browser WebSocket clients during the HTTP upgrade. */
export function terminalWebSocketProtocols(token: string): string[] {
  return [TERMINAL_WS_PROTOCOL, `${TERMINAL_WS_AUTH_PREFIX}${token}`];
}

/**
 * /ws/terminal framing (same convention as classic web terminals): binary
 * frames carry raw terminal bytes in both directions; text frames carry JSON
 * control messages. The client speaks first with `connect`; the server
 * answers with `ready` once the selected transport is attached, interleaving
 * `auth-prompt` / `host-key` round-trips before that for SSH sessions.
 */

/** Where a terminal session runs. Secrets (passwords, key passphrases) are
 *  never part of the profile — they travel only in `auth-response` replies. */
export const localProfileSchema = z.object({
  kind: z.literal('local'),
  /** Login shell override; empty/absent picks the server's default. */
  shell: z.string().optional(),
  cwd: z.string().optional(),
});

export const sshProfileSchema = z.object({
  kind: z.literal('ssh'),
  /**
   * Host alias from ~/.ssh/config, or an ad-hoc "[user@]host[:port]".
   * Everything else — HostName, User, Port, keys, ProxyJump, forwards —
   * resolves server-side from the config, exactly like `ssh <target>`.
   */
  target: z.string().min(1),
  /** False for a self-contained tunnel profile; jump aliases still resolve from config. */
  useConfig: z.boolean().optional(),
  /** Quick-connect overrides on top of config resolution. */
  user: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  /** Tunnel-owned overrides; passwords/passphrases still travel only in prompts. */
  identityFiles: z.array(z.string().min(1).max(4096)).max(32).optional(),
  identitiesOnly: z.boolean().optional(),
  forwardAgent: z.boolean().optional(),
  proxyJump: z.array(z.string().min(1).max(500)).max(8).optional(),
  passwordOnly: z.boolean().optional(),
});

export const telnetProfileSchema = z.object({
  kind: z.literal('telnet'),
  /** Stable Muxus database profile when this is a saved host. */
  profileId: z.string().min(1).max(200).optional(),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(23),
});

export const serialProfileSchema = z.object({
  kind: z.literal('serial'),
  /** Stable Muxus database profile when this is a saved host. */
  profileId: z.string().min(1).max(200).optional(),
  /** OS-native device path: COM3, /dev/ttyUSB0, /dev/tty.usbserial-…, etc. */
  path: z.string().trim().min(1).max(4096),
  baudRate: z.number().int().min(1).max(12_000_000).default(115_200),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(8),
  stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).default('none'),
  flowControl: z.enum(['none', 'hardware', 'software']).default('none'),
});

export const sessionProfileSchema = z.discriminatedUnion('kind', [
  localProfileSchema,
  sshProfileSchema,
  telnetProfileSchema,
  serialProfileSchema,
]);
export type SessionProfile = z.infer<typeof sessionProfileSchema>;
export type SshProfile = Extract<SessionProfile, { kind: 'ssh' }>;
export type LocalProfile = Extract<SessionProfile, { kind: 'local' }>;
export type TelnetProfile = Extract<SessionProfile, { kind: 'telnet' }>;
export type SerialProfile = Extract<SessionProfile, { kind: 'serial' }>;

/** Text frames the client sends on /ws/terminal. */
export const terminalClientMessageSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('connect'),
    profile: sessionProfileSchema,
    /** User-facing tab title retained in session history. */
    title: z.string().trim().min(1).max(500).optional(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  /**
   * Establish an SSH transport with no shell attached — the `ssh -N` of the
   * protocol, used to start tunnels without opening a terminal. The server
   * runs the same status/auth-prompt/host-key round-trips, then answers
   * `ready`; the transport lives until every lease on it (this socket's dial
   * lease, forwards started on the connId) is gone.
   */
  z.object({ op: z.literal('dial'), profile: sshProfileSchema }),
  z.object({ op: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  /** Answers to the last `auth-prompt`, in prompt order. */
  z.object({ op: z.literal('auth-response'), answers: z.array(z.string()) }),
  /** Verdict on the last `host-key` challenge. */
  z.object({ op: z.literal('host-key-response'), accept: z.boolean() }),
  /** Change only the current session; persisted policy is managed over REST. */
  z.object({
    op: z.literal('set-logging'),
    enabled: z.boolean().optional(),
    paused: z.boolean().optional(),
    captureInput: z.boolean().optional(),
  }).refine(
    (value) =>
      value.enabled !== undefined ||
      value.paused !== undefined ||
      value.captureInput !== undefined,
  ),
]);
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;

/** Text frames the server sends on /ws/terminal. */
export type TerminalServerMessage =
  /** Connection progress worth echoing into the terminal ("Connecting …"). */
  | { op: 'status'; message: string }
  /** Interactive auth (password, 2FA, key passphrase). echo=false → mask input. */
  | {
      op: 'auth-prompt';
      name?: string;
      instructions?: string;
      /** Which host in the connection chain is asking ("bastion", "user@web1"). */
      host?: string;
      prompts: Array<{ prompt: string; echo: boolean }>;
    }
  /** Host key verification: `new` = first contact (TOFU), `mismatch` = KEY CHANGED. */
  | {
      op: 'host-key';
      host: string;
      port: number;
      keyType: string;
      /** SHA256:… fingerprint, OpenSSH presentation. */
      fingerprint: string;
      state: 'new' | 'mismatch';
      /** Previously recorded fingerprint when state is `mismatch`. */
      previous?: string;
      /** Set when this is an intermediate ProxyJump hop, not the final target. */
      hop?: string;
    }
  /** Transport attached; SSH connIds also key follow-up SFTP/forward calls. */
  | { op: 'ready'; connId: string; host?: string; user?: string }
  /** Current durable-log state, emitted at start and after every live change. */
  | {
      op: 'logging-state';
      enabled: boolean;
      sessionId?: string;
      paused: boolean;
      captureInput: boolean;
      /** Present when storage/backpressure suspended logging for this session. */
      warning?: string;
    }
  | { op: 'exit'; code?: number; message?: string };
