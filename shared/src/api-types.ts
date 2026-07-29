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
  /**
   * Algorithm names the SSH engine can negotiate, per ssh_config keyword
   * ("Ciphers", "KexAlgorithms", "HostKeyAlgorithms", "MACs") — the editor
   * warns about entries the dialer would have to skip.
   */
  sshAlgorithms: Record<string, string[]>;
}

/**
 * ssh_config keywords the dialer applies even though they have no editor
 * field of their own (they are edited under Advanced). Everything else in
 * Advanced is preserved for OpenSSH but never used by Muxus itself.
 * Lowercased for comparison, per ssh_config's case-insensitive keywords.
 */
export const DIAL_TIME_KEYWORDS: ReadonlySet<string> = new Set([
  'ciphers',
  'kexalgorithms',
  'hostkeyalgorithms',
  'macs',
  'compression',
  'connecttimeout',
  'serveraliveinterval',
  'serveralivecountmax',
  'identityagent',
  'passwordauthentication',
  'kbdinteractiveauthentication',
  'challengeresponseauthentication',
  'preferredauthentications',
  'userknownhostsfile',
  'globalknownhostsfile',
  'setenv',
  'sendenv',
  'remotecommand',
  'requesttty',
  'stricthostkeychecking',
]);

export type UpdateCheckResult =
  | {
      available: true;
      currentVersion: string;
      latestVersion: string;
      releaseName?: string;
      releaseUrl: string;
      publishedAt?: string;
    }
  | {
      available: false;
      currentVersion: string;
      latestVersion?: string;
      reason?: string;
    };

/** Effective retention and privacy policy for one host (or "*" for defaults). */
export interface SessionLoggingPolicy {
  profileKey: string;
  enabled: boolean;
  /**
   * Record bytes sent by the user. Disabled by default because commands can
   * contain passwords, tokens, and other values that should not be retained.
   */
  captureInput: boolean;
  /** Rotate before a retained raw-log part grows beyond this many bytes. */
  maxPartBytes: number;
  /** Number of newest rotated parts retained for each session. */
  maxParts: number;
  /** True when an exact per-host override exists instead of inherited defaults. */
  overridden: boolean;
}

export interface SessionLoggingPolicyInput {
  enabled: boolean;
  captureInput: boolean;
  maxPartBytes: number;
  maxParts: number;
}

export type SessionLogStatus = 'active' | 'completed' | 'disconnected' | 'failed';
export type SessionLogDirection = 'input' | 'output' | 'system';

/** Durable session metadata returned by history list/search. */
export interface SessionLogSummary {
  id: string;
  profileKey: string;
  title: string;
  kind: import('./ws-protocol.js').SessionProfile['kind'];
  host: string;
  startedAt: string;
  endedAt?: string;
  status: SessionLogStatus;
  paused: boolean;
  captureInput: boolean;
  eventCount: number;
  rawBytes: number;
  normalizedBytes: number;
  partCount: number;
  /** Pinned sessions are excluded from age and quota eviction. */
  pinned: boolean;
  /** Search-context excerpt, present only for matching full-text queries. */
  snippet?: string;
}

/** One timestamped, normalized replay event. Raw bytes remain server-side. */
export interface SessionLogEvent {
  sequence: number;
  recordedAt: string;
  elapsedMs: number;
  direction: SessionLogDirection;
  text: string;
}

export interface SessionLogDetail extends SessionLogSummary {
  events: SessionLogEvent[];
  /** True when the API returned only the newest preview events. */
  eventsTruncated: boolean;
}

export interface SessionHistoryResponse {
  sessions: SessionLogSummary[];
  /** Opaque key for the next page. Exact result counts are intentionally omitted. */
  nextCursor?: string;
}

/** Global history limits. The per-host policy still owns segment size/count. */
export interface SessionHistorySettings {
  /** Configured root, or undefined when Muxus uses its platform default. */
  storageLocation?: string;
  /** Hard quota measured from actual files, including SQLite WAL/SHM files. */
  maxTotalBytes: number;
  minFreeBytes: number;
  minFreePercent: number;
  /** Completed, unpinned sessions older than this are removed; undefined disables it. */
  maxAgeDays?: number;
}

export interface SessionHistorySettingsInput {
  storageLocation?: string;
  maxTotalBytes: number;
  minFreeBytes: number;
  minFreePercent: number;
  maxAgeDays?: number;
}

export interface SessionHistoryStorageStatus {
  settings: SessionHistorySettings;
  activeStorageLocation: string;
  usageBytes: number;
  freeBytes: number;
  quotaSuspended: boolean;
  warning?: string;
  /** A changed storage path is picked up on the next Muxus launch. */
  restartRequired: boolean;
}

/** One serial device reported by the host OS through node-serialport. */
export interface SerialPortInfo {
  /** OS-native path (COM3, /dev/ttyUSB0, /dev/tty.usbserial-…, etc.). */
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
}

export interface SerialPortsResponse {
  ports: SerialPortInfo[];
}

export type SavedHostSessionProfile =
  | import('./ws-protocol.js').TelnetProfile
  | import('./ws-protocol.js').SerialProfile;

/** Telnet/serial host stored natively by Muxus rather than in ssh_config. */
export interface SavedHostProfile {
  id: string;
  kind: SavedHostSessionProfile['kind'];
  name: string;
  profile: SavedHostSessionProfile;
  metadata: OpenSshProfileMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface SavedHostProfileInput {
  id?: string;
  name: string;
  profile: SavedHostSessionProfile;
}

export interface SavedHostProfilesResponse {
  profiles: SavedHostProfile[];
}

/** One sidebar host, addressable across both host sources. */
export type ManagedHostRef =
  | { kind: 'ssh'; alias: string }
  | { kind: 'profile'; id: string };

/** One complete visual order for a sidebar group, mixing both host sources. */
export interface HostOrderRequest {
  hosts: ManagedHostRef[];
}

/**
 * One extra application window requested by the renderer. Session windows
 * start a fresh shell; SFTP windows stay attached to an existing SSH
 * transport and hold their own lease for as long as the window is open.
 */
export type AppWindowLaunch =
  | {
      kind: 'session';
      profile: import('./ws-protocol.js').SessionProfile;
      title: string;
      color?: string;
    }
  | {
      kind: 'sftp';
      connId: string;
      title: string;
      path?: string;
    };

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
  /** OpenSSH user certificates paired to matching IdentityFile keys. */
  certificateFiles?: string[];
  identitiesOnly?: boolean;
  forwardAgent?: boolean;
  /** ProxyJump hops in order ("bastion", "user@host:2222"); absent = none. */
  proxyJump?: string[];
  /** Shell command whose stdin/stdout provide the SSH transport. */
  proxyCommand?: string;
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
  /** User certificates paired with matching private IdentityFile keys. */
  certificateFiles: string[];
  identitiesOnly: boolean;
  forwardAgent: boolean;
  proxyJump: string[];
  /** Raw ProxyCommand after Host-pattern resolution; tokens expand at dial time. */
  proxyCommand?: string;
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

/** One literal terminal keyword and the colors used to render every match. */
export interface KeywordHighlightRule {
  /** Stable client-generated id used while editing and reordering rules. */
  id: string;
  keyword: string;
  /** xterm decorations require an opaque #RRGGBB color. */
  foreground: string;
  background?: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Host rules are additive by default, but can replace the global rule set. */
export interface HostKeywordHighlightConfig {
  inheritGlobal: boolean;
  rules: KeywordHighlightRule[];
}

export interface OpenSshProfileMetadata {
  /** Stable local ID survives an OpenSSH alias rename. */
  profileId: string;
  /** User-defined position inside the host's current sidebar group. */
  sortOrder?: number;
  displayName?: string;
  /** Muxus-only organizational group; does not alter the OpenSSH config file. */
  group?: string;
  color?: string;
  icon?: string;
  /** Muxus-only terminal highlighting for this OpenSSH alias. */
  keywordHighlights?: HostKeywordHighlightConfig;
  lastConnectedAt?: string;
  connectCount: number;
}

export interface OpenSshMetadataPatch {
  displayName?: string | null;
  group?: string | null;
  color?: string | null;
  icon?: string | null;
  keywordHighlights?: HostKeywordHighlightConfig | null;
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

/** A reusable mirrored-input target set owned by one workspace. */
export interface WorkspaceMultiExecGroup {
  id: string;
  name: string;
  /** Stable workspace terminal-tab IDs. */
  tabIds: string[];
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  layout: WorkspaceLayoutV1;
  multiExecGroups: WorkspaceMultiExecGroup[];
  /** At most one workspace is selected for startup. */
  isStartup: boolean;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export type WorkspaceSummary = Omit<WorkspaceRecord, 'layout' | 'multiExecGroups'>;

/** Persisted scrollback for one workspace terminal tab. */
export interface TerminalSnapshotRecord {
  tabId: string;
  /** Serialized terminal buffer, replayable by writing it back to a terminal. */
  data: string;
  updatedAt: string;
}

/** Upper bound for one tab's serialized scrollback, enforced on both sides. */
export const TERMINAL_SNAPSHOT_MAX_CHARS = 512_000;

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
