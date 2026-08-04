import { existsSync } from 'node:fs';
import os from 'node:os';
import pty from 'node-pty';
import type { LocalProfile } from '@muxus/shared';
import { shellIntegration } from './shell-integration.js';

export const DEFAULT_TERM = 'xterm-256color';

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
  const integration = shellIntegration(shell, process.env);
  const args = localPtyArgs(profile, integration.args);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!HOST_TERMINAL_ENV.test(key)) env[key] = value;
  }
  Object.assign(env, integration.env);
  env.TERM = DEFAULT_TERM;
  // Muxus renders 24-bit color; advertise it independently of terminfo.
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'muxus';
  const spawned = pty.spawn(shell, args, {
    name: DEFAULT_TERM,
    cols,
    rows,
    cwd: profile.cwd?.trim() || os.homedir(),
    env,
  });
  return { pty: spawned, shell };
}

export function localPtyArgs(
  profile: LocalProfile,
  integrationArgs: readonly string[],
): string[] {
  return [...integrationArgs, ...(profile.args ?? [])];
}

/** Normalize a saved startup action to terminal input. A PTY Enter is CR on
 * every supported platform; embedded newlines become separate Enter presses. */
export function localStartupInput(command: string | undefined): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  return `${trimmed.replace(/\r?\n/g, '\r')}\r`;
}

// Terminal control bytes are the protocol delimiters these expressions parse.
// oxlint-disable-next-line no-control-regex
const SHELL_PROMPT_OSC = /\x1b\](?:133|633);A(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/;
// oxlint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const COMMON_PROMPT_END = /(?:[$#>]|❯|➜)\s*$/u;

/** Detect the first interactive prompt without feeding startup text into shell
 * initialization. OSC 133/633 is authoritative; the visible fallback covers
 * default cmd, PowerShell, POSIX, fish, and common themed prompts. */
export function localShellPromptReady(output: string): boolean {
  if (SHELL_PROMPT_OSC.test(output)) return true;
  const visible = output.replace(ANSI_OSC, '').replace(ANSI_CSI, '');
  const line = visible.split(/[\r\n]/).at(-1) ?? '';
  return COMMON_PROMPT_END.test(line);
}
