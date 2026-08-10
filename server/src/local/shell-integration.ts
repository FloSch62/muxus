import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Shell integration for local terminals: rc shims that report the command
 * lifecycle via OSC 133 (FinalTerm) — D;<exit code> when a command finishes,
 * C when one starts — which the client turns into failed-command marks in
 * the scrollbar, the same mechanism VS Code uses. The shims source the
 * user's own startup files first, so prompts and plugins are untouched.
 */

export const ZSHENV = `# Muxus shell integration bootstrap. Sources your own .zshenv unmodified,
# then returns to the shim so .zshrc can hook in.
__muxus_shim="$ZDOTDIR"
if [[ -n "$MUXUS_USER_ZDOTDIR" ]]; then ZDOTDIR="$MUXUS_USER_ZDOTDIR"; else builtin unset ZDOTDIR; fi
if [[ -f "\${ZDOTDIR:-$HOME}/.zshenv" ]]; then builtin source "\${ZDOTDIR:-$HOME}/.zshenv"; fi
if [[ -n "$ZDOTDIR" ]]; then MUXUS_USER_ZDOTDIR="$ZDOTDIR"; else builtin unset MUXUS_USER_ZDOTDIR; fi
ZDOTDIR="$__muxus_shim"
builtin unset __muxus_shim
`;

/** Prompt hook shared by local and remote bash/zsh integrations. The value
 * follows VS Code's OSC 133/633 property escaping for backslashes and the
 * protocol's semicolon separator. */
export const SHELL_CWD_REPORT = `  __muxus_report_cwd() {
    local __muxus_cwd="$PWD"
    __muxus_cwd="\${__muxus_cwd//\\\\/\\\\\\\\}"
    __muxus_cwd="\${__muxus_cwd//;/\\\\x3b}"
    builtin printf '\\e]133;P;Cwd=%s\\a' "$__muxus_cwd"
  }
`;

export const ZSHRC = `# Muxus shell integration. Your .zshrc runs first, unmodified.
if [[ -n "$MUXUS_USER_ZDOTDIR" ]]; then ZDOTDIR="$MUXUS_USER_ZDOTDIR"; else builtin unset ZDOTDIR; fi
builtin unset MUXUS_USER_ZDOTDIR
if [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]]; then builtin source "\${ZDOTDIR:-$HOME}/.zshrc"; fi

if [[ -o interactive && -z "$__muxus_integrated" ]]; then
  builtin typeset -g __muxus_integrated=1
  builtin autoload -Uz add-zsh-hook
${SHELL_CWD_REPORT}
  __muxus_precmd() {
    local __muxus_status=$?
    builtin printf '\\e]133;D;%s\\a' "$__muxus_status"
    __muxus_report_cwd
    builtin printf '\\e]133;A\\a'
  }
  __muxus_preexec() {
    builtin printf '\\e]133;C\\a'
  }
  add-zsh-hook precmd __muxus_precmd
  add-zsh-hook preexec __muxus_preexec
fi
`;

const BASH_INIT = `# Muxus shell integration. Your normal startup files run first, unmodified.
if [[ -f /etc/bash.bashrc ]]; then . /etc/bash.bashrc; fi
if [[ -f "$HOME/.bashrc" ]]; then . "$HOME/.bashrc"; fi

if [[ $- == *i* && -z "$__muxus_integrated" ]]; then
  __muxus_integrated=1
${SHELL_CWD_REPORT}
  __muxus_prompt_mark() {
    local __muxus_status=$?
    printf '\\e]133;D;%s\\a' "$__muxus_status"
    __muxus_report_cwd
    printf '\\e]133;A\\a'
  }
  # PS0 expands once per executed command (never for an empty prompt), which
  # makes it a preexec without the DEBUG-trap fragility.
  PS0="\\[\\e]133;C\\a\\]\${PS0-}"
  PROMPT_COMMAND="__muxus_prompt_mark\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
`;

const FILES: ReadonlyArray<{ rel: string; content: string }> = [
  { rel: 'zsh/.zshenv', content: ZSHENV },
  { rel: 'zsh/.zshrc', content: ZSHRC },
  { rel: 'bash-init.bash', content: BASH_INIT },
];

/** Write the shim files under `root` (idempotent). */
export function writeIntegrationFiles(root: string): void {
  mkdirSync(path.join(root, 'zsh'), { recursive: true, mode: 0o700 });
  for (const { rel, content } of FILES) {
    writeFileSync(path.join(root, rel), content, { mode: 0o644 });
  }
}

let cachedRoot: string | null | undefined;

/** Shim directory (written once per process); null when unavailable. */
export function integrationRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  try {
    const base = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
    const root = path.join(base, 'muxus', 'shell-integration');
    writeIntegrationFiles(root);
    cachedRoot = root;
  } catch {
    cachedRoot = null;
  }
  return cachedRoot;
}

export interface ShellIntegration {
  args: string[];
  env: Record<string, string>;
}

// cmd.exe expands $E to ESC and $P to its current drive and directory every
// time it draws a prompt. Prefixing the user's prompt with this invisible OSC
// property gives Windows local terminals the same live cwd reports as the
// bash/zsh shims without replacing the visible prompt.
const CMD_CWD_PROMPT_PREFIX = '$E]133;P;CwdRaw=$P$E' + '\\';

/** Spawn arguments and env that switch integration on for a given shell.
 *  Unrecognized shells spawn untouched (fish emits OSC 133 on its own). */
export function shellIntegration(
  shell: string,
  baseEnv: NodeJS.ProcessEnv,
  root: string | null = integrationRoot(),
  platform: NodeJS.Platform = process.platform,
): ShellIntegration {
  const none: ShellIntegration = { args: [], env: {} };
  const name = platform === 'win32' ? path.win32.basename(shell).toLowerCase() : path.basename(shell);
  if (platform === 'win32') {
    if (name !== 'cmd' && name !== 'cmd.exe') return none;
    return {
      args: [],
      env: { PROMPT: `${CMD_CWD_PROMPT_PREFIX}${baseEnv.PROMPT || '$P$G'}` },
    };
  }
  if (!root) return none;
  if (name === 'zsh') {
    const env: Record<string, string> = { ZDOTDIR: path.join(root, 'zsh') };
    const userZdotdir = baseEnv.ZDOTDIR?.trim();
    if (userZdotdir) env.MUXUS_USER_ZDOTDIR = userZdotdir;
    return { args: [], env };
  }
  if (name === 'bash') {
    return { args: ['--init-file', path.join(root, 'bash-init.bash')], env: {} };
  }
  return none;
}
