import type { Algorithms } from 'ssh2';
import type { ResolvedTarget } from './ssh-config.js';
import ssh2Constants from './ssh2-internals.js';

/**
 * Translate the ssh_config algorithm lists (Ciphers, KexAlgorithms,
 * HostKeyAlgorithms, MACs) into ssh2's `algorithms` connect option.
 *
 * OpenSSH list syntax: a leading `+` appends to the default set, `^` moves to
 * its head, `-` removes from it, and a bare list replaces it entirely.
 * Entries may be `*`/`?` patterns; they expand against the supported table.
 *
 * The config file is usually shared with OpenSSH, which implements algorithms
 * ssh2 lacks (sntrup761x25519, mlkem768, …). Such entries are dropped and
 * reported instead of failing the dial — ssh2 throws on any name outside its
 * supported set, and an extra algorithm OpenSSH would offer must not break a
 * host Muxus could otherwise reach.
 */

// ssh2 publishes no API for its algorithm tables; read them from the same
// module instance the Client uses so this filter can never disagree with the
// handshake.
const CATEGORIES = [
  { option: 'ciphers', keyword: 'Ciphers', ssh2Key: 'cipher', supported: ssh2Constants.SUPPORTED_CIPHER },
  { option: 'kexAlgorithms', keyword: 'KexAlgorithms', ssh2Key: 'kex', supported: ssh2Constants.SUPPORTED_KEX },
  { option: 'hostKeyAlgorithms', keyword: 'HostKeyAlgorithms', ssh2Key: 'serverHostKey', supported: ssh2Constants.SUPPORTED_SERVER_HOST_KEY },
  { option: 'macs', keyword: 'MACs', ssh2Key: 'hmac', supported: ssh2Constants.SUPPORTED_MAC },
] as const;

type TranslatedList = string[] | Partial<Record<'append' | 'prepend' | 'remove', string[]>>;

export interface ConnectionAlgorithms {
  /** ssh2 connect option; undefined when the config requests nothing usable. */
  algorithms?: Algorithms;
  /** User-facing notices about config entries that had to be skipped. */
  notes: string[];
}

/** Per-keyword algorithm names ssh2 can negotiate (edit-time validation). */
export function supportedAlgorithms(): Record<string, string[]> {
  return Object.fromEntries(CATEGORIES.map((c) => [c.keyword, [...c.supported]]));
}

/** Throws when an exact list leaves no algorithm ssh2 could offer at all. */
export function connectionAlgorithms(
  resolved: Pick<ResolvedTarget, 'ciphers' | 'kexAlgorithms' | 'hostKeyAlgorithms' | 'macs' | 'compression'>,
): ConnectionAlgorithms {
  const out: Record<string, TranslatedList> = {};
  const notes: string[] = [];
  for (const category of CATEGORIES) {
    const value = resolved[category.option];
    if (!value) continue;
    const translated = translateList(value, category.keyword, category.supported, notes);
    if (translated) out[category.ssh2Key] = translated;
  }
  if (resolved.compression !== undefined) {
    // `Compression yes` prefers zlib the way `ssh -C` does; `no` pins the
    // ssh2 default of none but stops a zlib-preferring server from winning.
    out.compress = resolved.compression ? ['zlib@openssh.com', 'zlib', 'none'] : ['none'];
  }
  return {
    // Every name was filtered against ssh2's own supported tables above, so
    // the plain string lists satisfy the literal unions @types/ssh2 declares.
    algorithms: Object.keys(out).length ? (out as Algorithms) : undefined,
    notes,
  };
}

function translateList(
  value: string,
  keyword: string,
  supported: readonly string[],
  notes: string[],
): TranslatedList | undefined {
  const first = value[0];
  const mode = first === '+' ? 'append' : first === '^' ? 'prepend' : first === '-' ? 'remove' : 'exact';
  const list = mode === 'exact' ? value : value.slice(1);
  const names: string[] = [];
  const dropped: string[] = [];
  for (const token of list.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const matches = expandEntry(token, supported);
    // Removing an algorithm ssh2 never offers is a no-op, not a surprise.
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
  return names.length ? { [mode]: names } : undefined;
}

/** Expand one list entry against the supported table: exact name or `*`/`?` pattern. */
function expandEntry(token: string, supported: readonly string[]): string[] {
  if (!/[*?]/.test(token)) return supported.includes(token) ? [token] : [];
  const rx = new RegExp(
    `^${token.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  return supported.filter((name) => rx.test(name));
}
