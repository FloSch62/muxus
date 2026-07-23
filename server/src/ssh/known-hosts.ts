import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface KnownHostEntry {
  keyType: string;
  /** SHA256:… fingerprint, OpenSSH presentation. */
  fingerprint: string;
  addedAt: string;
}

/**
 * Trust-on-first-use host key store. Muxus keeps its own JSON store instead
 * of parsing ~/.ssh/known_hosts: the OpenSSH file's hashed-host entries can't
 * be enumerated, and writing to it from a GUI risks corrupting a file other
 * tooling depends on. First contact asks the user; a changed key blocks the
 * connection until the user explicitly accepts the new fingerprint.
 */
export class KnownHostsStore {
  private cache: Record<string, KnownHostEntry> | undefined;

  constructor(private readonly file = defaultKnownHostsPath()) {}

  lookup(host: string, port: number): KnownHostEntry | undefined {
    return this.load()[hostKey(host, port)];
  }

  record(host: string, port: number, keyType: string, fingerprint: string): void {
    const entries = { ...this.load() };
    entries[hostKey(host, port)] = { keyType, fingerprint, addedAt: new Date().toISOString() };
    this.save(entries);
  }

  private load(): Record<string, KnownHostEntry> {
    if (!this.cache) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, KnownHostEntry>) : {};
      } catch {
        this.cache = {};
      }
    }
    return this.cache;
  }

  private save(entries: Record<string, KnownHostEntry>): void {
    const tmp = `${this.file}.tmp`;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.cache = entries;
  }
}

function hostKey(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function defaultKnownHostsPath(): string {
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'));
  return path.join(base, 'muxus', 'known-hosts.json');
}
