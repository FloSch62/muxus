import path from 'node:path';
import type { Client, ClientChannel, PseudoTtyOptions, SFTPWrapper, Stats } from 'ssh2';
import { ZSHENV, ZSHRC } from '../local/shell-integration.js';

const SHELL_PROBE = `command printf '\\n__MUXUS_SHELL__=%s\\n__MUXUS_ZDOTDIR__=%s\\n' "\${SHELL-}" "\${ZDOTDIR-}"`;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT = 8 * 1024;
const INTEGRATION_VERSION = 'v1';

const ZPROFILE = `# Preserve login-zsh startup while ZDOTDIR points at the Muxus shim.
__muxus_shim="$ZDOTDIR"
if [[ -n "$MUXUS_USER_ZDOTDIR" ]]; then ZDOTDIR="$MUXUS_USER_ZDOTDIR"; else builtin unset ZDOTDIR; fi
if [[ -f "\${ZDOTDIR:-$HOME}/.zprofile" ]]; then builtin source "\${ZDOTDIR:-$HOME}/.zprofile"; fi
if [[ -n "$ZDOTDIR" ]]; then MUXUS_USER_ZDOTDIR="$ZDOTDIR"; else builtin unset MUXUS_USER_ZDOTDIR; fi
ZDOTDIR="$__muxus_shim"
builtin unset __muxus_shim
`;

const BASH_INIT = `# Muxus SSH shell integration. Reproduce login startup first.
if [[ -f /etc/profile ]]; then . /etc/profile; fi
if [[ -f "$HOME/.bash_profile" ]]; then
  . "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  . "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  . "$HOME/.profile"
fi

if [[ $- == *i* && -z "$__muxus_integrated" ]]; then
  __muxus_integrated=1
  __muxus_prompt_mark() {
    local __muxus_status=$?
    printf '\\e]133;D;%s\\a' "$__muxus_status"
    printf '\\e]133;A\\a'
  }
  PS0="\\[\\e]133;C\\a\\]\${PS0-}"
  PROMPT_COMMAND="__muxus_prompt_mark\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
`;

type SupportedShell = {
  path: string;
  kind: 'bash' | 'zsh';
  zdotdir?: string;
};

/**
 * Open a zsh/bash SSH session with the same OSC 133 command lifecycle
 * reporting as local terminals. Returns undefined when the remote cannot
 * support the bootstrap so callers can open a normal shell instead.
 */
export async function openIntegratedRemoteShell(
  client: Client,
  getSftp: () => Promise<SFTPWrapper>,
  pty: PseudoTtyOptions,
): Promise<ClientChannel | undefined> {
  const shell = await probeShell(client);
  if (!shell) return undefined;

  try {
    const root = await installIntegration(await getSftp(), shell.kind);
    return await openExec(client, remoteShellCommand(shell, root), { pty });
  } catch {
    return undefined;
  }
}

export function parseShellProbe(output: string): SupportedShell | undefined {
  const shellPath = /^__MUXUS_SHELL__=([^\r\n]+)$/m.exec(output)?.[1]?.trim();
  if (!shellPath || shellPath.includes('\0')) return undefined;
  const name = path.posix.basename(shellPath);
  if (name !== 'bash' && name !== 'zsh') return undefined;
  const zdotdir = /^__MUXUS_ZDOTDIR__=([^\r\n]*)$/m.exec(output)?.[1]?.trim();
  return { path: shellPath, kind: name, ...(zdotdir ? { zdotdir } : {}) };
}

export function remoteShellCommand(shell: SupportedShell, root: string): string {
  const executable = quoteShellWord(shell.path);
  if (shell.kind === 'bash') {
    return `exec ${executable} --noprofile --rcfile ${quoteShellWord(path.posix.join(root, 'bash-init.bash'))} -i`;
  }

  const userZdotdir = shell.zdotdir
    ? `export MUXUS_USER_ZDOTDIR=${quoteShellWord(shell.zdotdir)}; `
    : 'unset MUXUS_USER_ZDOTDIR; ';
  return `${userZdotdir}export ZDOTDIR=${quoteShellWord(path.posix.join(root, 'zsh'))}; exec ${executable} -l`;
}

async function probeShell(client: Client): Promise<SupportedShell | undefined> {
  let channel: ClientChannel;
  try {
    channel = await openExec(client, SHELL_PROBE);
  } catch {
    return undefined;
  }

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parseShellProbe(output));
    };
    const timer = setTimeout(() => {
      channel.destroy();
      finish();
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    channel.on('data', (chunk: Buffer | string) => {
      if (output.length < MAX_PROBE_OUTPUT) output += chunk.toString();
    });
    channel.once('close', finish);
    channel.once('error', finish);
  });
}

async function installIntegration(sftp: SFTPWrapper, kind: SupportedShell['kind']): Promise<string> {
  const home = await call<string>((cb) => sftp.realpath('.', cb));
  if (!home.startsWith('/')) throw new Error('remote home is not POSIX');
  const root = path.posix.join(home, '.cache', 'muxus', 'shell-integration', INTEGRATION_VERSION);
  const directories = kind === 'zsh' ? [root, path.posix.join(root, 'zsh')] : [root];
  for (const directory of directories) await ensureDirectory(sftp, directory);

  const files = kind === 'zsh'
    ? [
        { path: path.posix.join(root, 'zsh', '.zshenv'), content: ZSHENV },
        { path: path.posix.join(root, 'zsh', '.zprofile'), content: ZPROFILE },
        { path: path.posix.join(root, 'zsh', '.zshrc'), content: ZSHRC },
      ]
    : [{ path: path.posix.join(root, 'bash-init.bash'), content: BASH_INIT }];
  await Promise.all(files.map((file) => writeFile(sftp, file.path, file.content)));
  return root;
}

async function ensureDirectory(sftp: SFTPWrapper, directory: string): Promise<void> {
  const normalized = path.posix.normalize(directory);
  const parts = normalized.split('/').filter(Boolean);
  let current = '/';
  for (const part of parts) {
    current = path.posix.join(current, part);
    const existing = await call<Stats>((cb) => sftp.stat(current, cb)).catch(() => undefined);
    if (existing?.isDirectory()) continue;
    if (existing) throw new Error(`${current} is not a directory`);
    try {
      await call<void>((cb) => sftp.mkdir(current, { mode: 0o700 }, cb));
    } catch (error) {
      // Another terminal may have created it between stat and mkdir.
      const attrs = await call<Stats>((cb) => sftp.stat(current, cb)).catch(() => undefined);
      if (!attrs?.isDirectory()) throw error;
    }
  }
}

function writeFile(sftp: SFTPWrapper, remotePath: string, content: string): Promise<void> {
  return call<void>((cb) => sftp.writeFile(remotePath, content, { mode: 0o600 }, cb));
}

function openExec(
  client: Client,
  command: string,
  options?: { pty: PseudoTtyOptions },
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | undefined, channel: ClientChannel) =>
      error ? reject(error) : resolve(channel);
    if (options) client.exec(command, options, callback);
    else client.exec(command, callback);
  });
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function call<T>(
  operation: (callback: (error: Error | undefined | null, value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) =>
    operation((error, value) => (error ? reject(error) : resolve(value))),
  );
}
