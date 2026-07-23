/** Shape of every REST error body ({ message, code? }). */
export interface ApiErrorBody {
  message: string;
  code?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  /** Node's process.platform ('linux', 'win32', 'darwin', …). */
  platform: string;
  /** Home directory of the server user (initial cwd suggestions). */
  homeDir: string;
  /** Default login shell the server would spawn for local terminals. */
  defaultShell: string;
}

/** A LocalForward / RemoteForward / DynamicForward rule declared in ssh config. */
export interface ConfigForward {
  type: ForwardType;
  /** Listen port — local port for local/dynamic, remote bind port for remote. */
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
}

/**
 * Options written in one Host block — exactly what the editor round-trips.
 * Anything Muxus doesn't model stays verbatim in `extras`, so editing a block
 * never drops hand-written options.
 */
export interface HostBlockOptions {
  hostname?: string;
  user?: string;
  port?: number;
  identityFiles?: string[];
  identitiesOnly?: boolean;
  forwardAgent?: boolean;
  /** ProxyJump hops in order ("bastion", "user@host:2222"); absent = none. */
  proxyJump?: string[];
  forwards?: ConfigForward[];
  /** Skip public keys and go straight to password/keyboard-interactive. */
  passwordOnly?: boolean;
  /** Unmodeled options, order-preserved ("Compression yes", …). */
  extras?: Array<{ keyword: string; value: string }>;
}

/** Effective settings after full Host-pattern resolution (what connect uses). */
export interface ResolvedHostSettings {
  hostname: string;
  user?: string;
  port: number;
  identityFiles: string[];
  identitiesOnly: boolean;
  forwardAgent: boolean;
  proxyJump: string[];
  forwards: ConfigForward[];
  passwordOnly: boolean;
}

/** One connectable Host entry parsed from ~/.ssh/config. */
export interface SshHostEntry {
  /** Primary alias — the block's first concrete Host pattern. */
  alias: string;
  /** Every concrete alias on the block's Host line (includes `alias`). */
  aliases: string[];
  /** Comment lines sitting directly above the Host block. */
  description?: string;
  /** Absolute path of the config file the block lives in. */
  file: string;
  /** The block's own options (editing target). */
  options: HostBlockOptions;
  /** Effective values with `Host *`-style defaults applied (display + connect). */
  resolved: ResolvedHostSettings;
  /** Muxus-only metadata. Connection details still resolve live from OpenSSH. */
  metadata?: OpenSshProfileMetadata;
}

export interface OpenSshProfileMetadata {
  /** Stable local ID survives an OpenSSH alias rename. */
  profileId: string;
  favorite: boolean;
  /** User-defined position inside the host's current sidebar group. */
  sortOrder?: number;
  displayName?: string;
  /** Muxus-only organizational group; does not alter the OpenSSH config file. */
  group?: string;
  color?: string;
  icon?: string;
  lastConnectedAt?: string;
  connectCount: number;
}

export interface OpenSshMetadataPatch {
  favorite?: boolean;
  displayName?: string | null;
  group?: string | null;
  color?: string | null;
  icon?: string | null;
}

export interface WorkspaceConnectionRef {
  source: 'openssh' | 'profile';
  /** OpenSSH alias when source=openssh, stable database profile ID otherwise. */
  id: string;
}

export type WorkspaceTabLayout =
  | {
      id: string;
      kind: 'terminal';
      title: string;
      profile: import('./ws-protocol.js').SessionProfile;
      cwdHint?: string;
      /** User-set color flag marking the tab. */
      color?: string;
      /** Restoring a layout may offer a fresh connection; it never resumes a process. */
      offerReconnect: boolean;
    }
  | {
      id: string;
      kind: 'sftp';
      title: string;
      connection: WorkspaceConnectionRef;
      path?: string;
    }
  | {
      id: string;
      kind: 'editor';
      title: string;
      connection: WorkspaceConnectionRef;
      path?: string;
    };

export type WorkspaceNode =
  | {
      id: string;
      type: 'pane';
      tabs: WorkspaceTabLayout[];
      activeTabId?: string;
    }
  | {
      id: string;
      type: 'split';
      direction: 'horizontal' | 'vertical';
      /** Fraction occupied by children[0]. */
      ratio: number;
      children: [WorkspaceNode, WorkspaceNode];
    };

export interface WorkspaceLayoutV1 {
  version: 1;
  root: WorkspaceNode | null;
  activePaneId?: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  layout: WorkspaceLayoutV1;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export type WorkspaceSummary = Omit<WorkspaceRecord, 'layout'>;

export interface SshConfigResponse {
  /** Root config path (~/.ssh/config). */
  path: string;
  /** All config files read — root first, includes in evaluation order. */
  files: string[];
  hosts: SshHostEntry[];
  /** First parse problem encountered; hosts may be partial. */
  error?: string;
}

/** Create/update a Host block in ssh config. */
export interface HostUpsertRequest {
  /** Concrete aliases for the Host line (usually exactly one). */
  aliases: string[];
  description?: string;
  /** Config file to write to; defaults to the edited block's file or the root config. */
  file?: string;
  options: HostBlockOptions;
  /** When editing: primary alias of the block being replaced. */
  previousAlias?: string;
}

/** Serialized Host block exactly as it would be written to the config. */
export interface HostPreviewResponse {
  text: string;
}

/** Private key discovered in ~/.ssh. */
export interface SshKeyInfo {
  path: string;
  /** File name ("id_ed25519"). */
  name: string;
  /** Public key algorithm when known ("ssh-ed25519"). */
  type?: string;
  /** Comment from the sibling .pub file. */
  comment?: string;
  encrypted: boolean;
  /** Currently loaded in the SSH agent. */
  inAgent: boolean;
}

export interface SshAgentKey {
  type: string;
  comment?: string;
  /** SHA256:… fingerprint, OpenSSH presentation. */
  fingerprint: string;
}

export interface SshKeysResponse {
  agentAvailable: boolean;
  agentKeys: SshAgentKey[];
  keys: SshKeyInfo[];
}

export type SftpEntryType = 'file' | 'dir' | 'link' | 'other';

export interface SftpEntry {
  name: string;
  type: SftpEntryType;
  /** Bytes; absent for directories where the server did not report a size. */
  size?: number;
  /** Unix mtime in milliseconds. */
  mtimeMs?: number;
  /** Permission bits (the low 12 bits of st_mode). */
  mode?: number;
  owner?: string;
  group?: string;
  /** Short-lived, single-file capability used by Chromium's native DownloadURL drag format. */
  downloadTicket?: string;
}

export interface SftpListResponse {
  path: string;
  entries: SftpEntry[];
}

/** Text file opened through the remote editor. */
export interface SftpFileResponse {
  path: string;
  content: string;
  size: number;
  mtimeMs?: number;
  mode?: number;
}

/** Optimistic, text-only remote save request. */
export interface SftpFileSaveRequest {
  content: string;
  /** Modification time returned by the read/save that produced this buffer. */
  expectedMtimeMs?: number;
  /** Explicit conflict recovery chosen by the user. */
  force?: boolean;
}

export interface SftpFileSaveResponse {
  ok: true;
  size: number;
  mtimeMs?: number;
}

export type ForwardType = 'local' | 'remote' | 'dynamic';

export interface ForwardRequest {
  connId: string;
  type: ForwardType;
  /** Listen port — local port for local/dynamic, remote bind port for remote. */
  bindPort: number;
  /** Target of the tunnel; unused for dynamic (SOCKS picks per request). */
  targetHost?: string;
  targetPort?: number;
  /** Saved tunnel this forward realizes (running-state matching in the UI). */
  tunnelId?: string;
}

export interface ForwardInfo {
  id: string;
  connId: string;
  type: ForwardType;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
  /** config = auto-started from a *Forward line in ssh config; manual = added at runtime. */
  origin: 'config' | 'manual';
  /**
   * Session forwards belong to the terminal that created the connection and
   * stop with it. Independent forwards are explicitly saved/manual tunnels.
   */
  lifecycle: 'session' | 'independent';
  status: 'active' | 'error';
  error?: string;
  /** Saved tunnel this forward realizes, when it was started from one. */
  tunnelId?: string;
}

/**
 * A saved tunnel definition — a forwarding rule bound to an SSH target,
 * started and stopped independently of any terminal (the MobaXterm tunnel
 * workflow). Starting one reuses a live connection to the target when there
 * is one, otherwise dials a shell-less transport.
 */
export interface TunnelRecord {
  id: string;
  /** Display name; falls back to the rule description in the UI. */
  name?: string;
  /** SSH target — a config alias when sshOptions is absent, otherwise a hostname. */
  target: string;
  /**
   * Present for a tunnel-owned connection profile. Absent means "resolve this
   * target from OpenSSH config". Passwords and passphrases are never stored.
   * An empty object is meaningful: it selects an ad-hoc connection using the
   * default SSH agent/key discovery without inheriting an alias's settings.
   */
  sshOptions?: TunnelSshOptions;
  type: ForwardType;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
  createdAt: string;
  updatedAt: string;
}

/** Create/update a saved tunnel (id present = update). */
export interface TunnelInput {
  id?: string;
  name?: string;
  target: string;
  sshOptions?: TunnelSshOptions;
  type: ForwardType;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
}

/** Safe-to-persist SSH settings owned by a saved tunnel. */
export interface TunnelSshOptions {
  user?: string;
  port?: number;
  identityFiles?: string[];
  identitiesOnly?: boolean;
  forwardAgent?: boolean;
  /** Ordered ProxyJump specs: config aliases or "[user@]host[:port]". */
  proxyJump?: string[];
  /** Skip public keys and prompt for password/keyboard-interactive auth. */
  passwordOnly?: boolean;
}

export interface TunnelsResponse {
  tunnels: TunnelRecord[];
}

/** Live SSH transport summary (forwarding panel, connection reuse). */
export interface ConnectionInfo {
  id: string;
  /** What was dialed — config alias or ad-hoc "[user@]host[:port]". */
  target: string;
  host: string;
  port: number;
  user: string;
  /** Config alias when the target matches a Host block in ~/.ssh/config. */
  metadataAlias?: string;
}

export interface ConnectionsResponse {
  connections: ConnectionInfo[];
}
