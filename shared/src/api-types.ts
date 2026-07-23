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
}

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
}

export interface SftpListResponse {
  path: string;
  entries: SftpEntry[];
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
  status: 'active' | 'error';
  error?: string;
}
