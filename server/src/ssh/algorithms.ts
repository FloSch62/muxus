import type { ResolvedTarget } from './ssh-config.js';
import { algorithmSupport } from './engine.js';

/**
 * Translate the ssh_config algorithm lists (Ciphers, KexAlgorithms,
 * HostKeyAlgorithms, MACs) into the lists a connection offers.
 *
 * OpenSSH list syntax: a leading `+` appends to the default set, `^` moves to
 * its head, `-` removes from it, and a bare list replaces it entirely.
 * Entries may be `*`/`?` patterns; they expand against the supported table.
 *
 * The config file is usually shared with OpenSSH, which implements algorithms
 * the SSH engine lacks (sntrup761x25519, umac, …). Such entries are dropped
 * and reported instead of failing the dial: an extra algorithm OpenSSH would
 * offer must not break a host Muxus could otherwise reach.
 */

// The engine's own tables, so this filter can never disagree with the handshake.
const SUPPORT = algorithmSupport();

const CATEGORIES = [
  { option: 'ciphers', keyword: 'Ciphers', key: 'cipher', ...SUPPORT.cipher },
  { option: 'kexAlgorithms', keyword: 'KexAlgorithms', key: 'kex', ...SUPPORT.kex },
  { option: 'hostKeyAlgorithms', keyword: 'HostKeyAlgorithms', key: 'hostKey', ...SUPPORT.hostKey },
  { option: 'macs', keyword: 'MACs', key: 'mac', ...SUPPORT.mac },
] as const;

/** The lists a connection offers; an absent category keeps the engine's default. */
export interface EngineAlgorithms {
  kex?: string[];
  hostKey?: string[];
  cipher?: string[];
  mac?: string[];
  compression?: string[];
}

export interface ConnectionAlgorithms {
  /** Undefined when the config requests nothing that changes the defaults. */
  algorithms?: EngineAlgorithms;
  /** User-facing notices about config entries that had to be skipped. */
  notes: string[];
}

/** Per-keyword algorithm names the engine can negotiate (edit-time validation). */
export function supportedAlgorithms(): Record<string, string[]> {
  return Object.fromEntries(CATEGORIES.map((c) => [c.keyword, [...c.supported]]));
}

/**
 * A HostKeyAlgorithms value that asks the server for one key type first and
 * otherwise keeps the usual order.
 */
export function hostKeyAlgorithmsPreferring(keyType: string): string {
  const preferred = keyType === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [keyType];
  return [...preferred, ...SUPPORT.hostKey.defaults.filter((name) => !preferred.includes(name))].join(',');
}

/** Throws when an exact list leaves no algorithm the engine could offer at all. */
export function connectionAlgorithms(
  resolved: Pick<ResolvedTarget, 'ciphers' | 'kexAlgorithms' | 'hostKeyAlgorithms' | 'macs' | 'compression'>,
): ConnectionAlgorithms {
  const out: EngineAlgorithms = {};
  const notes: string[] = [];
  for (const category of CATEGORIES) {
    const value = resolved[category.option];
    if (!value) continue;
    const list = finalList(value, category.keyword, category.defaults, category.supported, notes);
    if (list) out[category.key] = list;
  }
  if (resolved.compression !== undefined) {
    // `Compression yes` prefers zlib the way `ssh -C` does; `no` stops a
    // zlib-preferring server from winning.
    out.compression = resolved.compression ? ['zlib@openssh.com', 'zlib', 'none'] : ['none'];
  }
  return { algorithms: Object.keys(out).length ? out : undefined, notes };
}

/** The list one config value leaves of a category; undefined when it changes nothing. */
function finalList(
  value: string,
  keyword: string,
  defaults: readonly string[],
  supported: readonly string[],
  notes: string[],
): string[] | undefined {
  const first = value[0];
  const mode = first === '+' ? 'append' : first === '^' ? 'prepend' : first === '-' ? 'remove' : 'exact';
  const list = mode === 'exact' ? value : value.slice(1);
  const names: string[] = [];
  const dropped: string[] = [];
  for (const token of list.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const matches = expandEntry(token, supported);
    // Removing an algorithm the engine never offers is a no-op, not a surprise.
    if (!matches.length && mode !== 'remove') dropped.push(token);
    for (const name of matches) if (!names.includes(name)) names.push(name);
  }
  if (dropped.length) {
    notes.push(`${keyword}: skipping ${dropped.join(', ')} — not supported by the SSH engine.`);
  }
  if (mode === 'exact') {
    if (!names.length) {
      throw new Error(`none of the ${keyword} in the ssh config ("${value}") are supported by the SSH engine`);
    }
    return names;
  }
  const result =
    mode === 'append'
      ? [...defaults, ...names.filter((name) => !defaults.includes(name))]
      : mode === 'prepend'
        ? [...names, ...defaults.filter((name) => !names.includes(name))]
        : defaults.filter((name) => !names.includes(name));
  const unchanged = result.length === defaults.length && result.every((name, i) => name === defaults[i]);
  if (unchanged) return undefined;
  if (!result.length) {
    throw new Error(`the ${keyword} in the ssh config ("${value}") leave nothing the SSH engine could offer`);
  }
  return result;
}

/** Expand one list entry against the supported table: exact name or `*`/`?` pattern. */
function expandEntry(token: string, supported: readonly string[]): string[] {
  if (!/[*?]/.test(token)) return supported.includes(token) ? [token] : [];
  const rx = new RegExp(
    `^${token.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  return supported.filter((name) => rx.test(name));
}
