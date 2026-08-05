import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Client, ClientChannel, PseudoTtyOptions, SFTPWrapper, Stats } from 'ssh2';
import { SHELL_CWD_REPORT, ZSHENV, ZSHRC } from '../local/shell-integration.js';

const SHELL_PROBE = `command printf '\\n__MUXUS_SHELL__=%s\\n__MUXUS_ZDOTDIR__=%s\\n__MUXUS_HOME__=%s\\n' "\${SHELL-}" "\${ZDOTDIR-}" "\${HOME-}"`;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT = 8 * 1024;

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
${SHELL_CWD_REPORT}
  __muxus_prompt_mark() {
    local __muxus_status=$?
    printf '\\e]133;D;%s\\a' "$__muxus_status"
    __muxus_report_cwd
    printf '\\e]133;A\\a'
  }
  PS0="\\[\\e]133;C\\a\\]\${PS0-}"
  PROMPT_COMMAND="__muxus_prompt_mark\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
`;

// A content-addressed directory makes the installed scripts immutable. Once
// the completion marker exists, future connections need only one SFTP stat
// instead of re-checking every parent and rewriting every file over the WAN.
const INTEGRATION_VERSION = createHash('sha256')
  .update(ZSHENV)
  .update(ZPROFILE)
  .update(ZSHRC)
  .update(BASH_INIT)
  .digest('hex')
  .slice(0, 12);
const INSTALL_COMPLETE = '.complete';

type SupportedShell = {
  path: string;
  kind: 'bash' | 'zsh';
  home: string;
  zdotdir?: string;
};

/**
 * The server dropped the whole SSH transport while Muxus was attempting the
 * optional Unix shell-integration setup or transitioning to its plain-shell
 * fallback. ConnectionManager uses this narrow signal to redial once as a
 * plain console session; ordinary channel rejections remain ordinary errors.
 */
export class RemoteShellTransportLostError extends Error {
  constructor(readonly transportError?: Error) {
    super('SSH transport was lost during remote shell integration setup.');
    this.name = 'RemoteShellTransportLostError';
  }
}

/**
 * Open a remote shell, adding OSC 133 integration for supported zsh/bash
 * hosts and falling back to a normal shell everywhere else. Transport-loss
 * observation spans both phases: some console servers close the probe channel
 * first and only disconnect the SSH transport while the plain shell opens.
 */
export async function openRemoteShell(
  client: Client,
  getSftp: () => Promise<SFTPWrapper>,
  pty: PseudoTtyOptions,
  env?: Record<string, string>,
): Promise<ClientChannel> {
  let transportLost = false;
  let transportError: Error | undefined;
  const onTransportError = (error: Error) => {
    transportLost = true;
    transportError = error;
  };
  const onTransportClose = () => {
    transportLost = true;
  };
  client.once('error', onTransportError);
  client.once('close', onTransportClose);
  client.once('end', onTransportClose);
  try {
    const integrated = await tryOpenIntegratedRemoteShell(client, getSftp, pty, env);
    if (integrated) return integrated;
    if (transportLost) throw new RemoteShellTransportLostError(transportError);

    try {
      return await openShell(client, pty, env);
    } catch (error) {
      if (transportLost || isDisconnectedError(error)) {
        throw new RemoteShellTransportLostError(
          transportError ?? (error instanceof Error ? error : undefined),
        );
      }
      throw error;
    }
  } finally {
    client.off('error', onTransportError);
    client.off('close', onTransportClose);
    client.off('end', onTransportClose);
  }
}

async function tryOpenIntegratedRemoteShell(
  client: Client,
  getSftp: () => Promise<SFTPWrapper>,
  pty: PseudoTtyOptions,
  env?: Record<string, string>,
): Promise<ClientChannel | undefined> {
  try {
    // Do not speculatively open SFTP against console appliances. Many expose
    // only a plain shell channel and some disconnect the whole transport when
    // an unsupported subsystem is requested.
    const shell = await probeShell(client);
    if (!shell) return undefined;
    const sftp = await getSftp();
    const root = await installIntegration(sftp, shell);
    return await openExec(client, remoteShellCommand(shell, root), { pty, ...(env ? { env } : {}) });
  } catch {
    return undefined;
  }
}

function isDisconnectedError(error: unknown): boolean {
  return error instanceof Error && /^(?:Not connected|Connection lost)/.test(error.message);
}

export function parseShellProbe(output: string): SupportedShell | undefined {
  const shellPath = /^__MUXUS_SHELL__=([^\r\n]+)$/m.exec(output)?.[1]?.trim();
  if (!shellPath || shellPath.includes('\0')) return undefined;
  const name = path.posix.basename(shellPath);
  if (name !== 'bash' && name !== 'zsh') return undefined;
  const home = /^__MUXUS_HOME__=(\/[^\r\n]*)$/m.exec(output)?.[1]?.trim();
  if (!home || home.includes('\0')) return undefined;
  const zdotdir = /^__MUXUS_ZDOTDIR__=([^\r\n]*)$/m.exec(output)?.[1]?.trim();
  return { path: shellPath, kind: name, home, ...(zdotdir ? { zdotdir } : {}) };
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

async function installIntegration(sftp: SFTPWrapper, shell: SupportedShell): Promise<string> {
  const root = path.posix.join(
    shell.home,
    '.cache',
    'muxus',
    'shell-integration',
    INTEGRATION_VERSION,
  );
  const completePath = path.posix.join(root, INSTALL_COMPLETE);
  const complete = await call<Stats>((cb) => sftp.stat(completePath, cb)).catch(() => undefined);
  if (complete?.isFile()) return root;

  const directories =
    shell.kind === 'zsh' ? [root, path.posix.join(root, 'zsh')] : [root];
  for (const directory of directories) await ensureDirectory(sftp, directory);

  const files = shell.kind === 'zsh'
    ? [
        { path: path.posix.join(root, 'zsh', '.zshenv'), content: ZSHENV },
        { path: path.posix.join(root, 'zsh', '.zprofile'), content: ZPROFILE },
        { path: path.posix.join(root, 'zsh', '.zshrc'), content: ZSHRC },
      ]
    : [{ path: path.posix.join(root, 'bash-init.bash'), content: BASH_INIT }];
  await Promise.all(files.map((file) => writeFile(sftp, file.path, file.content)));
  // Written last so interrupted installs are repaired on the next attempt.
  await writeFile(sftp, completePath, INTEGRATION_VERSION);
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
  options?: { pty: PseudoTtyOptions; env?: Record<string, string> },
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | undefined, channel: ClientChannel) =>
      error ? reject(error) : resolve(channel);
    if (options) client.exec(command, options, callback);
    else client.exec(command, callback);
  });
}

function openShell(
  client: Client,
  pty: PseudoTtyOptions,
  env?: Record<string, string>,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.shell(pty, { env }, (error, channel) =>
      error ? reject(error) : resolve(channel),
    );
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
