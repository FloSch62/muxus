import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigForward, HostBlockOptions, ResolvedHostSettings, SshHostEntry } from '@muxus/shared';

/**
 * OpenSSH per-user config engine. OpenSSH files remain the interoperable
 * source for connection details while Muxus owns UI metadata separately, so
 * this module does three jobs:
 *
 *  - parse the config (and its Includes) into a *line-preserving* document,
 *    so Host blocks can be edited in place without disturbing anything else
 *    (see ssh-config-edit.ts);
 *  - list the concrete Host aliases for the session manager, each with the
 *    block's own options plus the fully resolved effective settings;
 *  - resolve any target the way `ssh` would: sequential first-obtained-wins
 *    option lookup across matching Host patterns, accumulating IdentityFile,
 *    CertificateFile and *Forward directives.
 *
 * Known deviations from ssh_config(5): Match blocks are skipped (their
 * conditions need runtime state we don't have), and Include inside a Host
 * block is preserved verbatim instead of expanded.
 */

const MAX_INCLUDE_DEPTH = 8;

const CONFIG_LINE_RE = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=|\s)\s*(.*?)\s*$/;
const WILDCARD_RE = /[*?]/;

/** ~/.ssh/config — the OpenSSH per-user config location on macOS, Linux and Windows. */
export function defaultSshConfigPath(): string {
  return process.env.MUXUS_SSH_CONFIG ? path.resolve(process.env.MUXUS_SSH_CONFIG) : path.join(os.homedir(), '.ssh', 'config');
}

export function sshDir(): string {
  return path.join(os.homedir(), '.ssh');
}

/** One `Keyword value` line inside a block, with original casing preserved. */
export interface OptionLine {
  /** Keyword as written ("HostName"). */
  keyword: string;
  /** Lowercased keyword for comparisons. */
  key: string;
  /** Raw value text (quotes stripped only in `args`). */
  value: string;
  args: string[];
}

/** A `Host` block tied to its exact lines in one file. */
export interface HostBlock {
  file: string;
  /** Index of the first prelude comment line (== hostLine when none). */
  commentStart: number;
  hostLine: number;
  /** Exclusive end of the block's lines in its file. */
  end: number;
  patterns: string[];
  options: OptionLine[];
  /** Prelude comment text with leading `# ` stripped, newline-joined. */
  description?: string;
}

/** Config entries in evaluation order: Host blocks and unconditional top-level runs. */
interface SequenceEntry {
  /** null ⇒ applies to every host (top-level options outside any block). */
  patterns: string[] | null;
  options: OptionLine[];
}

export interface ConfigDocument {
  rootPath: string;
  /** path → file lines, for every file that was read. */
  files: Map<string, string[]>;
  /** Files in evaluation order (root first). Includes the root even if absent. */
  fileOrder: string[];
  blocks: HostBlock[];
  sequence: SequenceEntry[];
  /** First problem encountered (unreadable include, …); content may be partial. */
  error?: string;
}

export function loadConfigDocument(rootPath = defaultSshConfigPath()): ConfigDocument {
  const doc: ConfigDocument = {
    rootPath: path.resolve(rootPath),
    files: new Map(),
    fileOrder: [],
    blocks: [],
    sequence: [],
  };
  const state: ParseState = {
    doc,
    visited: new Set(),
    // Per ssh_config(5), relative Include paths resolve against the root
    // config's directory — even from included files.
    includeBase: path.dirname(path.resolve(rootPath)),
  };
  parseFile(doc.rootPath, state, 0);
  if (!doc.fileOrder.includes(doc.rootPath)) doc.fileOrder.unshift(doc.rootPath);
  return doc;
}

interface ParseState {
  doc: ConfigDocument;
  visited: Set<string>;
  includeBase: string;
}

function recordError(state: ParseState, message: string): void {
  if (!state.doc.error) state.doc.error = message;
}

function parseFile(file: string, state: ParseState, depth: number): void {
  const resolved = path.resolve(file);
  if (state.visited.has(resolved) || depth > MAX_INCLUDE_DEPTH) return;
  state.visited.add(resolved);

  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    // The root config's absence is normal; broken includes are worth surfacing.
    if (depth > 0) recordError(state, `could not read included file ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const lines = text.split(/\r?\n/);
  // A trailing newline produces one empty final element; drop it so appends
  // don't create gaps (serialization always re-adds the final newline).
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  state.doc.files.set(resolved, lines);
  state.doc.fileOrder.push(resolved);

  let block: HostBlock | null = null;
  let inMatch = false;
  let globals: SequenceEntry | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = CONFIG_LINE_RE.exec(line);
    if (!m) continue;
    const keyword = m[1] ?? '';
    const key = keyword.toLowerCase();
    const value = m[2] ?? '';
    let args: string[];
    try {
      args = splitArgs(value);
    } catch {
      recordError(state, `${resolved} line ${i + 1}: invalid quotes`);
      // Keep malformed option lines inside their block's editable range, but
      // don't let an invalid Host/Match header leak its options into globals.
      if (key === 'host' || key === 'match') {
        block = null;
        inMatch = true;
        globals = null;
      } else if (block && !inMatch) {
        block.end = i + 1;
      }
      continue;
    }
    const option: OptionLine = { keyword, key, value, args };

    if (key === 'host') {
      const commentStart = scanPreludeComments(lines, i);
      block = {
        file: resolved,
        commentStart,
        hostLine: i,
        end: i + 1,
        patterns: option.args.filter(Boolean),
        options: [],
        description: preludeText(lines, commentStart, i),
      };
      state.doc.blocks.push(block);
      state.doc.sequence.push({ patterns: block.patterns, options: block.options });
      inMatch = false;
      globals = null;
      continue;
    }
    if (key === 'match') {
      block = null;
      inMatch = true;
      globals = null;
      continue;
    }
    if (key === 'include' && !block && !inMatch) {
      for (const pattern of option.args) {
        for (const included of expandIncludePath(pattern, state.includeBase)) {
          parseFile(included, state, depth + 1);
        }
      }
      globals = null; // included content interleaves; keep evaluation order exact
      continue;
    }
    if (inMatch) continue; // Match-conditioned options are runtime-dependent; skip
    if (block) {
      block.options.push(option);
      block.end = i + 1;
      continue;
    }
    if (!globals) {
      globals = { patterns: null, options: [] };
      state.doc.sequence.push(globals);
    }
    globals.options.push(option);
  }
}

/** Walk back over the contiguous `#` lines directly above a Host line. */
function scanPreludeComments(lines: string[], hostLine: number): number {
  let j = hostLine - 1;
  while (j >= 0 && (lines[j] ?? '').trim().startsWith('#')) j--;
  return j + 1;
}

function preludeText(lines: string[], commentStart: number, hostLine: number): string | undefined {
  if (commentStart >= hostLine) return undefined;
  const text = lines
    .slice(commentStart, hostLine)
    .map((l) => l.trim().replace(/^#\s?/, ''))
    .join('\n')
    .trim();
  return text || undefined;
}

/**
 * Split a config value like OpenSSH's argv_split: single and double quotes may
 * appear anywhere in a token, and basic escapes remove their leading backslash.
 * Other backslashes (notably those in Windows paths) remain untouched.
 */
export function splitArgs(value: string): string[] {
  const out: string[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let started = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    const next = value[i + 1];
    if (
      char === '\\' &&
      (next === "'" || next === '"' || next === '\\' || (!quote && next === ' '))
    ) {
      token += next;
      i++;
      started = true;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      started = true;
    } else if (quote && char === quote) {
      quote = undefined;
    } else if ((char === ' ' || char === '\t') && !quote) {
      if (!started) continue;
      out.push(token);
      token = '';
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error('invalid quotes');
  if (started) out.push(token);
  return out;
}

// ---------------------------------------------------------------------------
// Pattern matching (ssh_config PATTERNS)
// ---------------------------------------------------------------------------

const globCache = new Map<string, RegExp>();

function globMatch(pattern: string, text: string): boolean {
  let rx = globCache.get(pattern);
  if (!rx) {
    const source = `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
    rx = new RegExp(source);
    globCache.set(pattern, rx);
  }
  return rx.test(text);
}

/** Match a Host line's pattern list: any positive match, unless a negation matches. */
export function hostPatternsMatch(patterns: string[], host: string): boolean {
  let matched = false;
  for (const p of patterns) {
    if (!p) continue;
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), host)) return false;
    } else if (globMatch(p, host)) {
      matched = true;
    }
  }
  return matched;
}

/** A concrete, connectable alias: no wildcards, not a negation. */
export function isConcreteAlias(pattern: string): boolean {
  return !!pattern && !pattern.startsWith('!') && !WILDCARD_RE.test(pattern);
}

// ---------------------------------------------------------------------------
// Resolution (what `ssh <host>` would use)
// ---------------------------------------------------------------------------

/** Resolved settings plus connection tunables the shared DTO doesn't carry. */
export interface ResolvedTarget extends ResolvedHostSettings {
  connectTimeout?: number;
  serverAliveInterval?: number;
  serverAliveCountMax?: number;
  /** Raw ssh_config algorithm lists; translated to ssh2 form at dial time. */
  ciphers?: string;
  kexAlgorithms?: string;
  hostKeyAlgorithms?: string;
  macs?: string;
  compression?: boolean;
  /** Agent socket override: a path, `$VAR`/`${VAR}`, `SSH_AUTH_SOCK`, or `none`. */
  identityAgent?: string;
  /** false ⇒ never try this method (`PasswordAuthentication no`). */
  passwordAuthentication?: boolean;
  kbdInteractiveAuthentication?: boolean;
  /** Expanded paths; [] means `none`. undefined ⇒ OpenSSH defaults. */
  userKnownHostsFiles?: string[];
  globalKnownHostsFiles?: string[];
  /** First-obtained value per variable, ssh_config SetEnv order. */
  setEnv: Record<string, string>;
  /** SendEnv patterns in obtained order, `-` removals included. */
  sendEnv: string[];
  remoteCommand?: string;
  requestTty?: 'no' | 'yes' | 'force' | 'auto';
  strictHostKeyChecking?: 'yes' | 'no' | 'accept-new' | 'ask';
}

const yes = (v: string | undefined): boolean => (v ?? '').toLowerCase() === 'yes';

/**
 * Resolve every option for `host` in ssh's sequential first-obtained-wins
 * order. IdentityFile, CertificateFile and the *Forward directives accumulate
 * instead. ProxyJump and ProxyCommand are mutually exclusive: whichever is
 * obtained first wins, matching OpenSSH.
 *
 * `fallback` options (Muxus folder defaults) are evaluated after the entire
 * config, as if appended at the end of ~/.ssh/config in a block matching only
 * this host — first-obtained-wins makes them fill gaps without ever beating
 * an option the user wrote in ssh_config.
 */
export function resolveHost(
  doc: ConfigDocument,
  host: string,
  fallback?: readonly OptionLine[],
): ResolvedTarget {
  const first = new Map<string, string>();
  const identityFiles: string[] = [];
  const certificateFiles: string[] = [];
  const forwards: ConfigForward[] = [];
  const setEnv: Record<string, string> = {};
  const sendEnv: string[] = [];

  const fallbackEntry = fallback?.length
    ? { patterns: null, options: [...fallback] }
    : undefined;
  const sequence = fallbackEntry ? [...doc.sequence, fallbackEntry] : doc.sequence;
  for (const entry of sequence) {
    if (entry.patterns && !hostPatternsMatch(entry.patterns, host)) continue;
    // IdentityFile is normally cumulative, but folder options are a fallback
    // layer rather than another ssh_config block. Once the config supplied a
    // key, omit all folder keys instead of offering them after it.
    const configProvidedIdentityFile = entry === fallbackEntry && identityFiles.length > 0;
    for (const opt of entry.options) {
      // OpenSSH treats ChallengeResponseAuthentication as an exact alias, so
      // both spellings share one first-obtained slot.
      const resolvedKey =
        opt.key === 'challengeresponseauthentication' ? 'kbdinteractiveauthentication' : opt.key;
      switch (opt.key) {
        case 'identityfile': {
          if (configProvidedIdentityFile) break;
          const file = opt.args[0];
          if (file && !identityFiles.includes(file)) identityFiles.push(file);
          break;
        }
        case 'setenv':
          for (const arg of opt.args) {
            const eq = arg.indexOf('=');
            if (eq <= 0) continue;
            const name = arg.slice(0, eq);
            if (!(name in setEnv)) setEnv[name] = arg.slice(eq + 1);
          }
          break;
        case 'sendenv':
          sendEnv.push(...opt.args.filter(Boolean));
          break;
        case 'certificatefile': {
          const file = opt.args[0];
          if (file && !certificateFiles.includes(file)) certificateFiles.push(file);
          break;
        }
        case 'proxyjump':
        case 'proxycommand': {
          const value = opt.key === 'proxyjump' ? opt.args[0] : opt.value;
          if (!first.has('proxyjump') && !first.has('proxycommand') && value) {
            first.set(opt.key, value);
          }
          break;
        }
        case 'localforward':
        case 'remoteforward':
        case 'dynamicforward': {
          const fwd = parseForwardOption(opt.key, opt.args);
          if (fwd) forwards.push(fwd);
          break;
        }
        default: {
          const value = RAW_RESOLVED_VALUE_KEYS.has(resolvedKey) ? opt.value : opt.args[0];
          if (RESOLVED_KEYS.has(resolvedKey) && !first.has(resolvedKey) && value) {
            first.set(resolvedKey, value);
          }
        }
      }
    }
  }

  const hostname = expandTokens(first.get('hostname') ?? host, { h: host });
  const user = first.get('user');
  const port = parsePort(first.get('port')) ?? 22;
  const preferred = first.get('preferredauthentications');
  const remoteUser = user ?? os.userInfo().username;
  const identityTokens = { h: hostname, r: remoteUser };
  const proxyJump = first.get('proxyjump');
  const knownHostsTokens: KnownHostsPathTokens = {
    h: hostname,
    n: host,
    p: port,
    r: remoteUser,
    j: proxyJump?.toLowerCase() === 'none' ? '' : (proxyJump ?? ''),
    k: host,
  };

  return {
    hostname,
    user,
    port,
    identityFiles: identityFiles.map((f) => expandIdentityPath(f, identityTokens)),
    certificateFiles: certificateFiles.map((f) => expandIdentityPath(f, identityTokens)),
    identitiesOnly: yes(first.get('identitiesonly')),
    forwardAgent: yes(first.get('forwardagent')),
    proxyJump: parseProxyJumpList(first.get('proxyjump')),
    proxyCommand: parseProxyCommand(first.get('proxycommand')),
    forwards,
    passwordOnly:
      (first.get('pubkeyauthentication') ?? '').toLowerCase() === 'no' ||
      (!!preferred && !preferred.toLowerCase().split(',').includes('publickey')),
    connectTimeout: parseNumber(first.get('connecttimeout')),
    serverAliveInterval: parseNumber(first.get('serveraliveinterval')),
    serverAliveCountMax: parseNumber(first.get('serveralivecountmax')),
    ciphers: first.get('ciphers'),
    kexAlgorithms: first.get('kexalgorithms'),
    hostKeyAlgorithms: first.get('hostkeyalgorithms'),
    macs: first.get('macs'),
    compression: flag(first.get('compression')),
    identityAgent: parseIdentityAgent(first.get('identityagent'), identityTokens),
    passwordAuthentication: flag(first.get('passwordauthentication')),
    kbdInteractiveAuthentication: flag(first.get('kbdinteractiveauthentication')),
    userKnownHostsFiles: parseKnownHostsFiles(first.get('userknownhostsfile'), knownHostsTokens),
    globalKnownHostsFiles: parseKnownHostsFiles(first.get('globalknownhostsfile'), knownHostsTokens),
    setEnv,
    sendEnv,
    remoteCommand: parseRemoteCommand(first.get('remotecommand')),
    requestTty: parseChoice(first.get('requesttty'), ['no', 'yes', 'force', 'auto']),
    strictHostKeyChecking: parseChoice(first.get('stricthostkeychecking'), ['yes', 'no', 'accept-new', 'ask']),
  };
}

/** yes/no → boolean; anything else (including unset) → undefined. */
function flag(value: string | undefined): boolean | undefined {
  const v = (value ?? '').toLowerCase();
  return v === 'yes' ? true : v === 'no' ? false : undefined;
}

function parseChoice<T extends string>(value: string | undefined, choices: readonly T[]): T | undefined {
  const v = (value ?? '').toLowerCase();
  return choices.includes(v as T) ? (v as T) : undefined;
}

/** `none`, `$VAR`/`${VAR}`, and `SSH_AUTH_SOCK` indirections pass through; paths expand. */
function parseIdentityAgent(value: string | undefined, tokens: { h: string; r: string }): string | undefined {
  if (!value) return undefined;
  if (value.toLowerCase() === 'none' || value.startsWith('$') || value === 'SSH_AUTH_SOCK') return value;
  return expandIdentityPath(value, tokens);
}

/** Space-separated path list; `none` → []; unset → undefined (defaults). */
function parseKnownHostsFiles(value: string | undefined, tokens: KnownHostsPathTokens): string[] | undefined {
  if (value === undefined) return undefined;
  const args = splitArgs(value).filter(Boolean);
  if (args.length === 1 && args[0]!.toLowerCase() === 'none') return [];
  return args.map((f) => expandKnownHostsPath(f, tokens));
}

/**
 * The environment for a session channel: process variables matched by the
 * SendEnv patterns (later `-pattern` entries remove earlier matches, as in
 * ssh_config), overridden by explicit SetEnv values. undefined when empty.
 */
export function sessionEnvironment(
  resolved: Pick<ResolvedTarget, 'setEnv' | 'sendEnv'>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const names = new Set<string>();
  for (const pattern of resolved.sendEnv) {
    if (pattern.startsWith('-')) {
      for (const name of names) if (globMatch(pattern.slice(1), name)) names.delete(name);
    } else {
      for (const name of Object.keys(source)) if (globMatch(pattern, name)) names.add(name);
    }
  }
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, resolved.setEnv);
  return Object.keys(env).length ? env : undefined;
}

const RESOLVED_KEYS = new Set([
  'hostname',
  'user',
  'port',
  'identitiesonly',
  'forwardagent',
  'preferredauthentications',
  'pubkeyauthentication',
  'connecttimeout',
  'serveraliveinterval',
  'serveralivecountmax',
  'ciphers',
  'kexalgorithms',
  'hostkeyalgorithms',
  'macs',
  'compression',
  'identityagent',
  'passwordauthentication',
  'kbdinteractiveauthentication',
  'userknownhostsfile',
  'globalknownhostsfile',
  'remotecommand',
  'requesttty',
  'stricthostkeychecking',
]);

/** Values whose consumers need the complete argument list or command text. */
const RAW_RESOLVED_VALUE_KEYS = new Set([
  'globalknownhostsfile',
  'remotecommand',
  'userknownhostsfile',
]);

function parseProxyCommand(value: string | undefined): string | undefined {
  return value && value.toLowerCase() !== 'none' ? value : undefined;
}

function parseRemoteCommand(value: string | undefined): string | undefined {
  return value && value.toLowerCase() !== 'none' ? value : undefined;
}

function parsePort(value: string | undefined): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** `ProxyJump a,user@b:2222,c` → hop specs in dialing order; `none` → []. */
export function parseProxyJumpList(value: string | undefined): string[] {
  if (!value || value.toLowerCase() === 'none') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `[user@]host[:port]` — a ProxyJump hop or quick-connect target. */
export function parseHostSpec(spec: string): { host: string; user?: string; port?: number } {
  let rest = spec.trim();
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    user = rest.slice(0, at) || undefined;
    rest = rest.slice(at + 1);
  }
  // [v6::addr]:port / bare v6 addresses keep their colons.
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracket) return { host: bracket[1] ?? '', user, port: parsePort(bracket[2]) };
  const colon = rest.lastIndexOf(':');
  if (colon > 0 && !rest.slice(0, colon).includes(':')) {
    const port = parsePort(rest.slice(colon + 1));
    if (port) return { host: rest.slice(0, colon), user, port };
  }
  return { host: rest, user };
}

/** Expand the %-tokens ssh allows in HostName (%h = originally requested name). */
function expandTokens(value: string, tokens: { h: string }): string {
  return value.replace(/%[%h]/g, (m) => (m === '%%' ? '%' : tokens.h));
}

/** Expand ~ and the common %-tokens in an identity or certificate path. */
export function expandIdentityPath(value: string, tokens: { h: string; r: string }): string {
  const home = os.homedir();
  let p = value.replace(/^~(?=$|[\\/])/, home);
  p = p.replace(/%[%dhur]/g, (m) => {
    if (m === '%%') return '%';
    if (m === '%d') return home;
    if (m === '%h') return tokens.h;
    if (m === '%r') return tokens.r;
    return os.userInfo().username; // %u
  });
  return p;
}

interface KnownHostsPathTokens {
  /** Resolved remote hostname. */
  h: string;
  /** Original host argument. */
  n: string;
  /** Resolved remote port. */
  p: number;
  /** Resolved remote username. */
  r: string;
  /** ProxyJump contents, or empty when unset. */
  j: string;
  /** HostKeyAlias, or the original host when none is configured. */
  k: string;
}

/** Expand the full token set OpenSSH accepts in UserKnownHostsFile paths. */
function expandKnownHostsPath(value: string, tokens: KnownHostsPathTokens): string {
  const home = os.homedir();
  const local = os.userInfo();
  const localHostname = os.hostname();
  const connectionHash = createHash('sha1')
    .update(`${localHostname}${tokens.h}${tokens.p}${tokens.r}${tokens.j}`)
    .digest('hex');
  const replacements: Record<string, string> = {
    '%%': '%',
    '%C': connectionHash,
    '%d': home,
    '%h': tokens.h,
    '%i': String(local.uid),
    '%j': tokens.j,
    '%k': tokens.k,
    '%L': localHostname.split('.')[0] ?? localHostname,
    '%l': localHostname,
    '%n': tokens.n,
    '%p': String(tokens.p),
    '%r': tokens.r,
    '%u': local.username,
  };
  return value
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/%%|%[CdhijkLlnpru]/g, (token) => replacements[token] ?? token);
}

/** Parse a LocalForward/RemoteForward/DynamicForward option's arguments. */
export function parseForwardOption(key: 'localforward' | 'remoteforward' | 'dynamicforward', args: string[]): ConfigForward | null {
  const bindPort = parseListenPort(args[0]);
  if (!bindPort) return null;
  if (key === 'dynamicforward') return { type: 'dynamic', bindPort };
  const target = parseTargetSpec(args[1]);
  if (!target) return null;
  return { type: key === 'localforward' ? 'local' : 'remote', bindPort, targetHost: target.host, targetPort: target.port };
}

/** `[bind_address:]port` (we always bind loopback; only the port matters). */
function parseListenPort(spec: string | undefined): number | undefined {
  if (!spec) return undefined;
  const idx = spec.lastIndexOf(':');
  return parsePort(idx >= 0 ? spec.slice(idx + 1) : spec);
}

/** `host:port` or `host/port`. */
function parseTargetSpec(spec: string | undefined): { host: string; port: number } | undefined {
  if (!spec) return undefined;
  const sep = spec.lastIndexOf(spec.includes('/') ? '/' : ':');
  if (sep <= 0) return undefined;
  const port = parsePort(spec.slice(sep + 1));
  const host = spec.slice(0, sep).replace(/^\[|\]$/g, '');
  return host && port ? { host, port } : undefined;
}

// ---------------------------------------------------------------------------
// Listing (the session manager's data)
// ---------------------------------------------------------------------------

/** Map a block's own option lines to the editable DTO; unmodeled lines land in extras. */
export function blockToOptions(block: HostBlock): HostBlockOptions {
  const out: HostBlockOptions = {};
  const extras: Array<{ keyword: string; value: string }> = [];
  let preferredConsumed = false;
  let proxyConsumed = false;

  for (const opt of block.options) {
    switch (opt.key) {
      case 'hostname':
        if (out.hostname === undefined) out.hostname = opt.args[0];
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      case 'user':
        if (out.user === undefined) out.user = opt.args[0];
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      case 'port': {
        const port = parsePort(opt.args[0]);
        if (port && out.port === undefined) out.port = port;
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      }
      case 'identityfile':
        if (opt.args[0]) (out.identityFiles ??= []).push(opt.args[0]);
        break;
      case 'certificatefile':
        if (opt.args[0]) (out.certificateFiles ??= []).push(opt.args[0]);
        break;
      case 'identitiesonly':
        out.identitiesOnly = yes(opt.args[0]);
        break;
      case 'identityagent':
        if (out.identityAgent === undefined && opt.args[0]) out.identityAgent = opt.args[0];
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      case 'forwardagent':
        out.forwardAgent = yes(opt.args[0]);
        break;
      case 'proxyjump':
        if (!proxyConsumed) {
          out.proxyJump = parseProxyJumpList(opt.value);
          proxyConsumed = true;
        } else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      case 'proxycommand':
        if (!proxyConsumed) {
          const command = parseProxyCommand(opt.value);
          if (command) out.proxyCommand = command;
          else extras.push({ keyword: opt.keyword, value: opt.value });
          proxyConsumed = true;
        } else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      case 'localforward':
      case 'remoteforward':
      case 'dynamicforward': {
        const fwd = parseForwardOption(opt.key, opt.args);
        if (fwd) (out.forwards ??= []).push(fwd);
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      }
      case 'pubkeyauthentication':
        if ((opt.args[0] ?? '').toLowerCase() === 'no') out.passwordOnly = true;
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      case 'preferredauthentications':
        // Our canonical passwordOnly pair; anything else is a hand-written policy.
        if (opt.value.toLowerCase() === 'keyboard-interactive,password') preferredConsumed = true;
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      case 'remotecommand':
        if (out.remoteCommand === undefined && opt.value) out.remoteCommand = opt.value;
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      case 'requesttty': {
        const requestTty = parseChoice(opt.value, ['no', 'yes', 'force', 'auto']);
        if (requestTty && out.requestTty === undefined) out.requestTty = requestTty;
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      }
      case 'stricthostkeychecking': {
        const strict = parseChoice(opt.value, ['yes', 'no', 'accept-new', 'ask']);
        if (strict && out.strictHostKeyChecking === undefined) out.strictHostKeyChecking = strict;
        else extras.push({ keyword: opt.keyword, value: opt.value });
        break;
      }
      default:
        extras.push({ keyword: opt.keyword, value: opt.value });
    }
  }
  if (preferredConsumed && !out.passwordOnly) {
    // PreferredAuthentications without PubkeyAuthentication no — preserve it.
    extras.push({ keyword: 'PreferredAuthentications', value: 'keyboard-interactive,password' });
  }
  if (extras.length) out.extras = extras;
  return out;
}

export function listHosts(
  doc: ConfigDocument,
  /** Folder defaults per alias — resolved values then match what connect uses. */
  fallbackFor?: (alias: string) => readonly OptionLine[] | undefined,
): SshHostEntry[] {
  const seen = new Set<string>();
  const entries: SshHostEntry[] = [];
  for (const block of doc.blocks) {
    const concrete = block.patterns.filter(isConcreteAlias);
    const fresh = concrete.filter((a) => !seen.has(a));
    if (!fresh.length) continue;
    for (const a of concrete) seen.add(a);
    const alias = fresh[0]!;
    const resolved = resolveHost(doc, alias, fallbackFor?.(alias));
    entries.push({
      alias,
      aliases: concrete,
      description: block.description,
      file: block.file,
      options: blockToOptions(block),
      resolved: {
        hostname: resolved.hostname,
        user: resolved.user,
        port: resolved.port,
        identityFiles: resolved.identityFiles,
        certificateFiles: resolved.certificateFiles,
        identitiesOnly: resolved.identitiesOnly,
        identityAgent: resolved.identityAgent,
        forwardAgent: resolved.forwardAgent,
        proxyJump: resolved.proxyJump,
        proxyCommand: resolved.proxyCommand,
        forwards: resolved.forwards,
        passwordOnly: resolved.passwordOnly,
      },
    });
  }
  return entries;
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
