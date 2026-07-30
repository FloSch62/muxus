import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Host key verification against the real OpenSSH files: ~/.ssh/known_hosts
 * (read + write) and /etc/ssh/ssh_known_hosts (read only). Supports plain,
 * wildcard and hashed (|1|salt|hmac) host entries, `[host]:port` notation and
 * the @revoked marker. First contact asks the user (TOFU) and appends a plain
 * entry, like `ssh` with HashKnownHosts=no; accepting a changed key replaces
 * the stale same-type entries the way `ssh-keygen -R` would, keeping a
 * known_hosts.old backup.
 */

export type KnownHostVerdict =
  | { state: 'ok' }
  | { state: 'unknown' }
  | { state: 'changed'; previous: string }
  | { state: 'revoked' };

interface KnownHostLine {
  marker?: 'revoked' | 'cert-authority';
  hosts: string;
  keyType: string;
  keyB64: string;
}

export function defaultKnownHostsPath(): string {
  return path.join(os.homedir(), '.ssh', 'known_hosts');
}

const GLOBAL_KNOWN_HOSTS = '/etc/ssh/ssh_known_hosts';

/** SHA256:… fingerprint, OpenSSH presentation. */
export function fingerprintSha256(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** "ssh-ed25519", "ecdsa-sha2-nistp256", … — the leading string of the key blob. */
export function hostKeyType(key: Buffer): string {
  try {
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString('latin1');
  } catch {
    return 'unknown';
  }
}

export class KnownHostsStore {
  /** New entries land in the first user file; the rest are read-only. */
  private readonly userFiles: string[];
  private readonly globalFiles: string[];

  /** Arrays follow UserKnownHostsFile/GlobalKnownHostsFile: [] means `none`. */
  constructor(
    userFiles: string | string[] = defaultKnownHostsPath(),
    globalFiles: string | string[] = GLOBAL_KNOWN_HOSTS,
  ) {
    this.userFiles = Array.isArray(userFiles) ? userFiles : [userFiles];
    this.globalFiles = Array.isArray(globalFiles) ? globalFiles : [globalFiles];
  }

  verify(host: string, port: number, key: Buffer): KnownHostVerdict {
    const names = hostNames(host, port);
    const keyType = hostKeyType(key);
    const keyB64 = key.toString('base64');
    let previous: string | undefined;

    for (const file of [...this.userFiles, ...this.globalFiles]) {
      for (const entry of readEntries(file)) {
        if (entry.marker === 'cert-authority') continue; // CA validation is out of scope
        if (entry.keyType !== keyType || !entryMatches(entry.hosts, names)) continue;
        if (entry.keyB64 === keyB64) {
          if (entry.marker === 'revoked') return { state: 'revoked' };
          return { state: 'ok' };
        }
        previous ??= fingerprintSha256(Buffer.from(entry.keyB64, 'base64'));
      }
    }
    return previous ? { state: 'changed', previous } : { state: 'unknown' };
  }

  /**
   * Record an accepted key: drop stale same-type entries for the host (the
   * `ssh-keygen -R` part, backing up to known_hosts.old), then append.
   */
  record(host: string, port: number, key: Buffer): void {
    const target = this.userFiles[0];
    if (!target) return; // UserKnownHostsFile none — nowhere to remember it
    // OpenSSH users commonly select the null device to accept host keys
    // without persisting them. Our atomic sibling-file rewrite cannot apply
    // there, and the device already provides the intended discard semantics.
    if (target === os.devNull) return;
    const names = hostNames(host, port);
    const keyType = hostKeyType(key);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

    let lines: string[] = [];
    try {
      const text = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(`${target}.old`, text, { mode: 0o600 });
      lines = text.split(/\r?\n/);
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
    } catch {
      // First entry ever.
    }

    const kept = lines.filter((line) => {
      const entry = parseLine(line);
      return !entry || entry.marker !== undefined || entry.keyType !== keyType || !entryMatches(entry.hosts, names);
    });
    kept.push(`${names[0]} ${keyType} ${key.toString('base64')}`);

    const tmp = `${target}.muxus.tmp`;
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
}

/** The names OpenSSH would store/check for this host+port. */
function hostNames(host: string, port: number): [string, ...string[]] {
  const h = host.toLowerCase();
  return port === 22 ? [h, `[${h}]:22`] : [`[${h}]:${port}`];
}

function* readEntries(file: string): Generator<KnownHostLine> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const entry = parseLine(raw);
    if (entry) yield entry;
  }
}

function parseLine(raw: string): KnownHostLine | undefined {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return undefined;
  const fields = line.split(/\s+/);
  let marker: KnownHostLine['marker'];
  if (fields[0] === '@revoked' || fields[0] === '@cert-authority') {
    marker = fields.shift()!.slice(1) as KnownHostLine['marker'];
  }
  const [hosts, keyType, keyB64] = fields;
  if (!hosts || !keyType || !keyB64) return undefined;
  return { marker, hosts, keyType, keyB64 };
}

/** Match one entry's host field (comma-separated patterns or a |1| hash). */
function entryMatches(hostsField: string, names: string[]): boolean {
  if (hostsField.startsWith('|')) return hashedMatches(hostsField, names);
  let matched = false;
  for (const pattern of hostsField.split(',')) {
    const p = pattern.toLowerCase();
    if (!p) continue;
    if (p.startsWith('!')) {
      if (names.some((n) => globMatch(p.slice(1), n))) return false;
    } else if (names.some((n) => globMatch(p, n))) {
      matched = true;
    }
  }
  return matched;
}

/** |1|base64(salt)|base64(hmac-sha1(salt, host)) */
function hashedMatches(field: string, names: string[]): boolean {
  const parts = field.split('|');
  if (parts.length !== 4 || parts[1] !== '1') return false;
  try {
    const salt = Buffer.from(parts[2]!, 'base64');
    const hash = Buffer.from(parts[3]!, 'base64');
    return names.some((name) => {
      const mac = createHmac('sha1', salt).update(name).digest();
      return mac.length === hash.length && timingSafeEqual(mac, hash);
    });
  } catch {
    return false;
  }
}

const globCache = new Map<string, RegExp>();

function globMatch(pattern: string, text: string): boolean {
  let rx = globCache.get(pattern);
  if (!rx) {
    rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    globCache.set(pattern, rx);
  }
  return rx.test(text);
}
