import { z } from 'zod';

/** Fixed subprotocol selected by the server for terminal sockets. */
export const TERMINAL_WS_PROTOCOL = 'muxus.terminal.v1';
/** Authentication is offered as a non-selected subprotocol so it stays out of request URLs. */
export const TERMINAL_WS_AUTH_PREFIX = 'muxus.auth.';
/** Clean-close reason that explicitly ends the backend terminal lifecycle. */
export const TERMINAL_SESSION_CLOSE_REASON = 'terminal session closed';

/** Upper bound for the Muxus-wide ServerAliveInterval fallback, in seconds. */
export const MAX_SSH_KEEPALIVE_INTERVAL_SECONDS = 3600;

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
  shell: z.string().max(4096).optional(),
  /** Arguments passed to the shell executable without command-line re-parsing. */
  args: z.array(z.string().max(4096)).max(64).optional(),
  cwd: z.string().max(4096).optional(),
  /** Text entered after the interactive shell starts, followed by Enter. */
  startupCommand: z.string().max(32_768).optional(),
});

export const sshProfileSchema = z.object({
  kind: z.literal('ssh'),
  /** Stable Muxus database profile when this is a saved host. */
  profileId: z.string().min(1).max(200).optional(),
  /**
   * Host alias from ~/.ssh/config, or an ad-hoc "[user@]host[:port]".
   * Everything else — HostName, User, Port, keys, ProxyJump, forwards —
   * resolves server-side from the config, exactly like `ssh <target>`.
   */
  target: z.string().min(1),
  /** False for a self-contained saved host or tunnel; jump aliases may still resolve from config. */
  useConfig: z.boolean().optional(),
  /**
   * Muxus-wide fallback for ServerAliveInterval, in seconds. An explicit
   * ssh_config value still wins for the host or jump hop.
   */
  keepaliveIntervalSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_SSH_KEEPALIVE_INTERVAL_SECONDS)
    .optional(),
  /** Quick-connect overrides on top of config resolution. */
  user: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  /** Tunnel-owned overrides; passwords/passphrases still travel only in prompts. */
  identityFiles: z.array(z.string().min(1).max(4096)).max(32).optional(),
  certificateFiles: z.array(z.string().min(1).max(4096)).max(32).optional(),
  identitiesOnly: z.boolean().optional(),
  /** Agent socket path, environment indirection, SSH_AUTH_SOCK, or none. */
  identityAgent: z.string().min(1).max(4096).optional(),
  forwardAgent: z.boolean().optional(),
  /** Absent = the platform default (on with the bundled Windows X server). */
  forwardX11: z.boolean().optional(),
  proxyJump: z.array(z.string().min(1).max(500)).max(8).optional(),
  proxyCommand: z.string().min(1).max(32_768).optional(),
  forwards: z
    .array(
      z.object({
        type: z.enum(['local', 'remote', 'dynamic']),
        bindPort: z.number().int().min(1).max(65535),
        targetHost: z.string().min(1).max(4096).optional(),
        targetPort: z.number().int().min(1).max(65535).optional(),
      }),
    )
    .max(64)
    .optional(),
  passwordOnly: z.boolean().optional(),
  remoteCommand: z.string().min(1).max(32_768).optional(),
  requestTty: z.enum(['no', 'yes', 'force', 'auto']).optional(),
  strictHostKeyChecking: z.enum(['yes', 'no', 'accept-new', 'ask']).optional(),
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

/**
 * SSH host a remote desktop is reached through, the way `ssh -L` would carry
 * it: the desktop's host and port are resolved on the far side of this hop.
 */
export const sshGatewaySchema = z.object({
  /** ssh_config alias, or the saved SSH host's target when `profileId` is set. */
  target: z.string().trim().min(1).max(500),
  /** Muxus-owned SSH host; absent resolves `target` through ssh_config. */
  profileId: z.string().min(1).max(200).optional(),
});

export const rdpProfileSchema = z.object({
  kind: z.literal('rdp'),
  /** Stable Muxus database profile when this is a saved host. */
  profileId: z.string().min(1).max(200).optional(),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(3389),
  /** Logon name; `DOMAIN\user` and `user@domain` work as typed. */
  username: z.string().trim().max(256).optional(),
  domain: z.string().trim().max(256).optional(),
  sshGateway: sshGatewaySchema.optional(),
  /** Text clipboard redirection; absent means on, as in mstsc. */
  shareClipboard: z.boolean().optional(),
});

export const vncProfileSchema = z.object({
  kind: z.literal('vnc'),
  /** Stable Muxus database profile when this is a saved host. */
  profileId: z.string().min(1).max(200).optional(),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(5900),
  /** Only servers with user logins ask for one (VeNCrypt, Apple Remote Desktop, UltraVNC). */
  username: z.string().trim().max(256).optional(),
  sshGateway: sshGatewaySchema.optional(),
  /** Ask the server to resize its desktop to the pane instead of scaling the picture. */
  resizeRemote: z.boolean().optional(),
  /** Watch without sending keyboard or mouse input. */
  viewOnly: z.boolean().optional(),
  /** Text clipboard sharing; absent means on. */
  shareClipboard: z.boolean().optional(),
});

/** Sessions rendered by xterm.js over /ws/terminal. */
export const terminalProfileSchema = z.discriminatedUnion('kind', [
  localProfileSchema,
  sshProfileSchema,
  telnetProfileSchema,
  serialProfileSchema,
]);

/** Sessions drawn as a remote screen over /ws/desktop. */
export const desktopProfileSchema = z.discriminatedUnion('kind', [
  rdpProfileSchema,
  vncProfileSchema,
]);

export const sessionProfileSchema = z.discriminatedUnion('kind', [
  localProfileSchema,
  sshProfileSchema,
  telnetProfileSchema,
  serialProfileSchema,
  rdpProfileSchema,
  vncProfileSchema,
]);
export type SessionProfile = z.infer<typeof sessionProfileSchema>;
export type SshProfile = Extract<SessionProfile, { kind: 'ssh' }>;
export type LocalProfile = Extract<SessionProfile, { kind: 'local' }>;
export type TelnetProfile = Extract<SessionProfile, { kind: 'telnet' }>;
export type SerialProfile = Extract<SessionProfile, { kind: 'serial' }>;
export type RdpProfile = Extract<SessionProfile, { kind: 'rdp' }>;
export type VncProfile = Extract<SessionProfile, { kind: 'vnc' }>;
export type SshGateway = z.infer<typeof sshGatewaySchema>;
export type DesktopProfile = z.infer<typeof desktopProfileSchema>;
export type TerminalProfile = z.infer<typeof terminalProfileSchema>;

export function isDesktopProfile(profile: SessionProfile): profile is DesktopProfile {
  return profile.kind === 'rdp' || profile.kind === 'vnc';
}

export type AuthPromptPurpose =
  | 'authentication'
  | 'ssh-password'
  | 'vault-unlock'
  | 'vault-repair'
  | 'vault-create';

export interface AuthPromptInfo {
  name?: string;
  instructions?: string;
  /** Which host in the connection chain is asking ("bastion", "user@web1"). */
  host?: string;
  prompts: Array<{ prompt: string; echo: boolean }>;
  purpose?: AuthPromptPurpose;
  /** Offer to encrypt a successful SSH password in the local vault. */
  rememberPassword?: {
    label: string;
    /** True when remembering will replace an older saved password. */
    existing: boolean;
  };
  /** Secondary action that continues without answering this prompt. */
  skipLabel?: string;
}

export interface AuthPromptResponse {
  answers: string[];
  rememberPassword?: boolean;
  skipped?: boolean;
}

/** Text frames the client sends on /ws/terminal. */
export const terminalClientMessageSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('connect'),
    profile: terminalProfileSchema,
    /**
     * Replacement-group token: skip SSH transports established before this
     * request and dial a replacement. Connects carrying the same token share
     * one replacement connection (one login for a force-reconnected window).
     */
    freshTransport: z.string().min(1).max(100).optional(),
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
  /** Attach to a live terminal after a renderer interruption or window handoff. */
  z.object({
    op: z.literal('attach'),
    terminalId: z.string().min(1).max(200),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  /** Freeze outbound bytes before the source renderer snapshots its buffer. */
  z.object({ op: z.literal('prepare-transfer') }),
  /** Resume the source renderer when a prepared handoff is abandoned. */
  z.object({ op: z.literal('cancel-transfer') }),
  z.object({ op: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  /** Answers to the last `auth-prompt`, in prompt order. */
  z.object({
    op: z.literal('auth-response'),
    answers: z.array(z.string().max(8192)).max(16),
    rememberPassword: z.boolean().optional(),
    skipped: z.boolean().optional(),
  }),
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
  /** Stable server-side identity used for renderer reattachment and window handoff. */
  | { op: 'session'; terminalId: string }
  /** Outbound terminal bytes are frozen and can now be snapshotted without a gap. */
  | { op: 'transfer-ready' }
  /** Connection progress worth echoing into the terminal ("Connecting …"). */
  | { op: 'status'; message: string; transient?: boolean }
  /** Passive SSH transport health derived from the existing keepalive lifecycle. */
  | { op: 'connection-health'; state: 'healthy' | 'suspect' }
  /** Interactive auth (password, 2FA, key passphrase). echo=false → mask input. */
  | ({ op: 'auth-prompt' } & AuthPromptInfo)
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
  /** Transport attached; SSH connIds also key follow-up SFTP/forward calls when available. */
  | { op: 'ready'; connId: string; host?: string; user?: string; sftpAvailable?: boolean }
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
  | {
      op: 'exit';
      code?: number;
      message?: string;
      /** Whether the shell ended normally, setup failed, or a live transport was lost. */
      reason: 'completed' | 'failed' | 'disconnected';
    };

/**
 * /ws/desktop: one control socket per RDP/VNC tab. The client sends `connect`;
 * the server dials any SSH gateway (with the same auth-prompt/host-key
 * round-trips as a terminal), gathers credentials, then answers `ready` with a
 * single-use ticket. The picture itself travels on a second socket that
 * presents the ticket: /ws/desktop/rdp for IronRDP's RDCleanPath handshake,
 * /ws/desktop/vnc (ticket as a subprotocol) for noVNC's raw RFB stream.
 */
export const DESKTOP_RDP_WS_PATH = '/ws/desktop/rdp';
export const DESKTOP_VNC_WS_PATH = '/ws/desktop/vnc';
/** A VNC stream socket offers its ticket as this subprotocol prefix. */
export const DESKTOP_TICKET_PROTOCOL_PREFIX = 'muxus.ticket.';

/** Text frames the client sends on /ws/desktop. */
export const desktopClientMessageSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('connect'), profile: desktopProfileSchema }),
  z.object({
    op: z.literal('auth-response'),
    answers: z.array(z.string().max(8192)).max(16),
    rememberPassword: z.boolean().optional(),
    skipped: z.boolean().optional(),
  }),
  z.object({ op: z.literal('host-key-response'), accept: z.boolean() }),
  z.object({ op: z.literal('certificate-response'), accept: z.boolean() }),
  /**
   * Start another attempt with a fresh ticket. `rejected` means the server
   * refused the last credentials, so they are asked for again.
   */
  z.object({ op: z.literal('retry'), rejected: z.boolean().optional() }),
  /** A VNC server asked for these credentials mid-handshake. */
  z.object({
    op: z.literal('credentials-request'),
    types: z.array(z.enum(['username', 'password'])).min(1).max(2),
  }),
  /** The remote desktop accepted the login; a password marked to remember is saved now. */
  z.object({ op: z.literal('connected') }),
]);
export type DesktopClientMessage = z.infer<typeof desktopClientMessageSchema>;

export interface DesktopCredentials {
  username?: string;
  password?: string;
  domain?: string;
}

/** TLS certificate an RDP server presented that is not trusted yet. */
export interface DesktopCertificateChallenge {
  host: string;
  port: number;
  /** SHA256:… fingerprint of the leaf certificate, base64 like OpenSSH. */
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** Why the certificate could not be verified against trusted authorities. */
  verificationError?: string;
  /** `new` = first contact (TOFU), `mismatch` = differs from the one trusted before. */
  state: 'new' | 'mismatch';
  previous?: string;
}

/** Text frames the server sends on /ws/desktop. */
export type DesktopServerMessage =
  | { op: 'status'; message: string; transient?: boolean }
  | ({ op: 'auth-prompt' } & AuthPromptInfo)
  | Extract<TerminalServerMessage, { op: 'host-key' }>
  | ({ op: 'certificate' } & DesktopCertificateChallenge)
  /** A ticket for the stream socket, plus the logon for RDP (NLA runs in the client). */
  | { op: 'ready'; ticket: string; credentials?: DesktopCredentials }
  /** Answer to `credentials-request`. */
  | { op: 'credentials'; credentials: DesktopCredentials }
  | {
      op: 'exit';
      message?: string;
      reason: 'completed' | 'failed' | 'disconnected';
    };
