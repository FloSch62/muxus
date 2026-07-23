import { existsSync } from 'node:fs';
import os from 'node:os';
import pty from 'node-pty';
import type { LocalProfile } from '@muxus/shared';
import { resolveTermEnv } from './term-env.js';
import { shellIntegration } from './shell-integration.js';

export { DEFAULT_TERM } from './term-env.js';

/** The login shell a local terminal spawns when the profile has no override. */
export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe';
  const fromEnv = process.env.SHELL;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
}

/** Vars describing whatever terminal launched the Muxus server itself —
 *  wrong and misleading inside PTYs that Muxus owns. */
const HOST_TERMINAL_ENV =
  /^(TERMINFO|TERM_PROGRAM|TERM_PROGRAM_VERSION|VTE_VERSION|WT_SESSION|WT_PROFILE_ID|KONSOLE_VERSION|KONSOLE_DBUS_\w+|ITERM_SESSION_ID|GNOME_TERMINAL_\w+|KITTY_\w+|WEZTERM_\w+|ALACRITTY_\w+)$/;

export interface LocalPty {
  pty: pty.IPty;
  shell: string;
}

export function spawnLocalPty(profile: LocalProfile, cols: number, rows: number): LocalPty {
  const shell = profile.shell?.trim() || defaultShell();
  const resolved = resolveTermEnv(profile.term);
  const integration = shellIntegration(shell, process.env);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!HOST_TERMINAL_ENV.test(key)) env[key] = value;
  }
  Object.assign(env, integration.env);
  env.TERM = resolved.term;
  if (resolved.terminfo) env.TERMINFO = resolved.terminfo;
  // Muxus renders 24-bit color; make sure TUIs pick it up even when the
  // host's terminfo entry for TERM is missing or stale.
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'muxus';
  const spawned = pty.spawn(shell, integration.args, {
    name: resolved.term,
    cols,
    rows,
    cwd: profile.cwd?.trim() || os.homedir(),
    env,
  });
  return { pty: spawned, shell };
}
