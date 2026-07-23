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

/** One connectable Host alias parsed from ~/.ssh/config (display hints only). */
export interface SshConfigHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
}

export interface SshConfigResponse {
  configPath: string;
  hosts: SshConfigHost[];
  /** First parse problem encountered; hosts may be partial. */
  error?: string;
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
  status: 'active' | 'error';
  error?: string;
}
