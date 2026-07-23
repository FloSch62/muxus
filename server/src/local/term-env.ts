import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Broad compatibility default; users can opt into xterm-kitty per profile. */
export const DEFAULT_TERM = 'xterm-256color';

/** Standard terminfo databases, in ncurses search order. */
function systemTerminfoDirs(): string[] {
  const dirs = [path.join(os.homedir(), '.terminfo')];
  for (const dir of process.env.TERMINFO_DIRS?.split(':') ?? []) {
    if (dir) dirs.push(dir);
  }
  dirs.push('/etc/terminfo', '/lib/terminfo', '/usr/share/terminfo', '/usr/local/share/terminfo');
  return dirs;
}

/**
 * Places kitty keeps its terminfo when it is not in the system database —
 * kitty only exports TERMINFO to terminals it spawned itself, so a Muxus
 * launched from the desktop cannot see it without this search.
 */
function kittyTerminfoDirs(): string[] {
  const dirs: string[] = [];
  const install = process.env.KITTY_INSTALLATION_DIR?.trim();
  if (install) dirs.push(path.join(install, 'terminfo'));
  dirs.push(
    path.join(os.homedir(), '.local/kitty.app/lib/kitty/terminfo'),
    '/opt/kitty/lib/kitty/terminfo',
    '/usr/lib/kitty/terminfo',
    '/Applications/kitty.app/Contents/Resources/kitty/terminfo',
  );
  return dirs;
}

/** Whether `dir` holds an entry for `term` (single-letter or hex layout). */
function hasEntry(dir: string, term: string): boolean {
  const letter = term[0]!;
  const hex = letter.charCodeAt(0).toString(16);
  return existsSync(path.join(dir, letter, term)) || existsSync(path.join(dir, hex, term));
}

export interface TermEnv {
  term: string;
  /** Set as TERMINFO when the entry lives outside the standard database. */
  terminfo?: string;
}

/**
 * Pick a TERM the spawned shell can actually resolve. The requested name is
 * kept when its terminfo exists; xterm-kitty additionally searches kitty's
 * install locations and points TERMINFO there. Anything unresolvable falls
 * back to DEFAULT_TERM so `clear` & co never hit "unknown terminal type".
 */
export function resolveTermEnv(
  requested: string | undefined,
  dirs: { system?: string[]; extra?: string[] } = {},
): TermEnv {
  const term = requested?.trim() || DEFAULT_TERM;
  if (process.platform === 'win32') return { term };
  const system = dirs.system ?? systemTerminfoDirs();
  if (system.some((dir) => hasEntry(dir, term))) return { term };
  const extra = dirs.extra ?? (term === 'xterm-kitty' ? kittyTerminfoDirs() : []);
  const found = extra.find((dir) => hasEntry(dir, term));
  if (found) return { term, terminfo: found };
  return { term: DEFAULT_TERM };
}
