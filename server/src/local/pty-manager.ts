import { existsSync } from 'node:fs';
import os from 'node:os';
import pty from 'node-pty';
import type { LocalProfile } from '@muxus/shared';

export const DEFAULT_TERM = 'xterm-kitty';

/** The login shell a local terminal spawns when the profile has no override. */
export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe';
  const fromEnv = process.env.SHELL;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
}

export interface LocalPty {
  pty: pty.IPty;
  shell: string;
}

export function spawnLocalPty(profile: LocalProfile, cols: number, rows: number): LocalPty {
  const shell = profile.shell?.trim() || defaultShell();
  const term = profile.term?.trim() || DEFAULT_TERM;
  const spawned = pty.spawn(shell, [], {
    name: term,
    cols,
    rows,
    cwd: profile.cwd?.trim() || os.homedir(),
    env: {
      ...process.env,
      TERM: term,
      // Muxus renders 24-bit color; make sure TUIs pick it up even when the
      // host's terminfo entry for TERM is missing or stale.
      COLORTERM: 'truecolor',
    },
  });
  return { pty: spawned, shell };
}
