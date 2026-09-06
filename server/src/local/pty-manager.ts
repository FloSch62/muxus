import { existsSync } from 'node:fs';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
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
  shell: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export function spawnLocalPty(
  profile: LocalProfile, cols: number, rows: number,
  events: { data(data: string): void; exit(code: number): void },
): LocalPty {
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
  const decoder = new StringDecoder('utf8');
  let drained!: () => void;
  const outputClosed = new Promise<void>((resolve) => { drained = resolve; });
  // Inline terminal options make Bun establish the child's controlling TTY.
  // Passing a separately created Terminal only attaches its file descriptors
  // and leaves POSIX shells without job control.
  const child = Bun.spawn([shell, ...args], {
    terminal: {
      name: DEFAULT_TERM, cols, rows,
      data: (_, bytes) => { const text = decoder.write(Buffer.from(bytes)); if (text) events.data(text); },
      exit: () => drained(),
    },
    cwd: profile.cwd?.trim() || os.homedir(), env,
  });
  const terminal = child.terminal!;
  void child.exited.then(async (code) => {
    // Drain the final output. A background descendant may keep the slave open
    // after the shell exits, so it must not hold the session open indefinitely.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([outputClosed, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 200); })]);
    clearTimeout(timeout);
    terminal.close();
    const tail = decoder.end();
    if (tail) events.data(tail);
    events.exit(code);
  });
  return {
    shell,
    write: (data) => { if (!terminal.closed) terminal.write(data); },
    resize: (nextCols, nextRows) => { if (!terminal.closed) terminal.resize(nextCols, nextRows); },
    kill: () => {
      // Kill before closing ConPTY: older Windows versions otherwise block
      // while conhost waits for the attached process to finish.
      if (child.exitCode === null) child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGHUP');
      terminal.close();
    },
  };
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
