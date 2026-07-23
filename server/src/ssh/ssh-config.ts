import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SshConfigHost } from '@muxus/shared';

/**
 * Read the `Host` aliases a user can actually connect to from their OpenSSH
 * per-user config, so the UI can offer them in the session sidebar. This is a
 * *listing* parser, not a matcher: wildcard/negated patterns and Match blocks
 * are skipped, and per-block HostName/User/Port are captured purely as
 * connection hints.
 */

const MAX_INCLUDE_DEPTH = 8;

const CONFIG_LINE_RE = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=|\s)\s*(.*)$/;
const WILDCARD_RE = /[*?]/;
const ARG_TOKEN_RE = /"([^"]*)"|(\S+)/g;

/** ~/.ssh/config — the OpenSSH per-user config location on macOS, Linux and Windows. */
export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
}

export interface SshConfigParseResult {
  hosts: SshConfigHost[];
  /** First problem encountered (unreadable include, oversized file …); hosts may be partial. */
  error?: string;
}

export function parseSshConfigHosts(configPath = defaultSshConfigPath()): SshConfigParseResult {
  const state: ParseState = {
    hosts: new Map(),
    visited: new Set(),
    // Per ssh_config(5), relative Include paths in per-user configs resolve
    // against ~/.ssh (the root config's directory) — even from included files.
    includeBase: path.dirname(path.resolve(configPath)),
  };
  parseFile(configPath, state, 0);
  return { hosts: [...state.hosts.values()], error: state.error };
}

interface ParseState {
  hosts: Map<string, SshConfigHost>;
  visited: Set<string>;
  includeBase: string;
  error?: string;
}

function recordError(state: ParseState, message: string): void {
  if (!state.error) state.error = message;
}

function parseFile(file: string, state: ParseState, depth: number): void {
  const resolved = path.resolve(file);
  if (state.visited.has(resolved) || depth > MAX_INCLUDE_DEPTH) return;
  state.visited.add(resolved);

  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    // The root config's absence is the caller's (non-)news; broken includes are worth surfacing.
    if (depth > 0) recordError(state, `could not read included file ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Entries in the current Host block; null while inside Match blocks or before any Host.
  let block: SshConfigHost[] | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // `Keyword value`, `Keyword=value` and `Keyword = value` are all valid.
    const m = CONFIG_LINE_RE.exec(line);
    if (!m) continue;
    const keyword = (m[1] ?? '').toLowerCase();
    const args = splitArgs(m[2] ?? '');

    switch (keyword) {
      case 'host': {
        block = [];
        for (const pattern of args) {
          if (!pattern || WILDCARD_RE.test(pattern) || pattern.startsWith('!')) continue;
          let entry = state.hosts.get(pattern);
          if (!entry) {
            entry = { alias: pattern };
            state.hosts.set(pattern, entry);
          }
          block.push(entry);
        }
        break;
      }
      case 'match':
        block = null;
        break;
      case 'include':
        for (const pattern of args) {
          for (const included of expandIncludePath(pattern, state.includeBase)) {
            parseFile(included, state, depth + 1);
          }
        }
        break;
      case 'hostname':
      case 'user':
      case 'port': {
        if (!block || !args[0]) break;
        for (const entry of block) {
          // First obtained value wins, matching ssh's own semantics.
          if (keyword === 'hostname' && entry.hostname === undefined) entry.hostname = args[0];
          if (keyword === 'user' && entry.user === undefined) entry.user = args[0];
          if (keyword === 'port' && entry.port === undefined) {
            const port = Number(args[0]);
            if (Number.isInteger(port) && port > 0 && port < 65536) entry.port = port;
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

/** Split a config value into tokens, honoring double quotes. */
function splitArgs(value: string): string[] {
  const out: string[] = [];
  ARG_TOKEN_RE.lastIndex = 0;
  for (let m = ARG_TOKEN_RE.exec(value); m; m = ARG_TOKEN_RE.exec(value)) out.push(m[1] ?? m[2] ?? '');
  return out;
}

/** Resolve an Include argument to concrete files, supporting `~` and filename-level `*`/`?` globs. */
function expandIncludePath(pattern: string, includeBase: string): string[] {
  let p = pattern.replace(/^~(?=$|[\\/])/, os.homedir());
  if (!path.isAbsolute(p)) p = path.join(includeBase, p);
  const name = path.basename(p);
  if (!WILDCARD_RE.test(name)) return [p];
  const dir = path.dirname(p);
  const rx = new RegExp(
    `^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.')}$`,
  );
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => rx.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
