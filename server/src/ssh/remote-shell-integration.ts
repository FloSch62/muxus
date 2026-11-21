import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  isSshError,
  type PtyRequest,
  type SessionOptions,
  type SftpClient,
  type SshChannel,
  type SshTransport,
} from './engine.js';
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

// Runs last in bash and zsh startup, so the user's own rc files cannot undo
// it and nothing is typed into the shell (where it would echo and land in
// history).
const RESTORE_CWD = `
if [[ -n "\${MUXUS_RESTORE_CWD-}" ]]; then
  builtin cd -- "$MUXUS_RESTORE_CWD" 2>/dev/null ||
    builtin printf 'Muxus: could not restore the previous working directory.\\n'
fi
builtin unset MUXUS_RESTORE_CWD
`;

const REMOTE_ZSHRC = `${ZSHRC}${RESTORE_CWD}`;

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
${RESTORE_CWD}`;

// A content-addressed directory makes the installed scripts immutable. Once
// the completion marker exists, future connections need only one SFTP stat
// instead of re-checking every parent and rewriting every file over the WAN.
const INTEGRATION_VERSION = createHash('sha256')
  .update(ZSHENV)
  .update(ZPROFILE)
  .update(REMOTE_ZSHRC)
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
 * What the shell probe learned about one transport, shared by its shells.
 * `ranCommand`: the server ran the probe, so it runs commands at all.
 * `execRefused`: it answered the probe's exec with failure. Nokia SR OS then
 * holds that channel's slot until the connection closes, so later shells on
 * the transport skip the probe instead of spending another slot on it.
 */
export interface ShellProbeMemo {
  ranCommand: boolean;
  execRefused: boolean;
}

/**
 * Open a remote shell, adding OSC 133 integration for supported zsh/bash
 * hosts and falling back to a normal shell everywhere else. Transport-loss
 * observation spans both phases: some console servers close the probe channel
 * first and only disconnect the SSH transport while the plain shell opens.
 */
export async function openRemoteShell(
  transport: SshTransport,
  getSftp: () => Promise<SftpClient>,
  options: SessionOptions & { pty: PtyRequest },
  cwd?: string,
  probe?: ShellProbeMemo,
): Promise<SshChannel> {
  let transportLost = false;
  let transportError: Error | undefined;
  const stopWatching = transport.onClose((reason) => {
    transportLost = true;
    if (reason) transportError = new Error(reason);
  });
  try {
    const integrated = probe?.execRefused
      ? undefined
      : await tryOpenIntegratedRemoteShell(transport, getSftp, options, cwd, probe);
    if (integrated) return integrated;
    if (transportLost || transport.closed) throw new RemoteShellTransportLostError(transportError);

    try {
      return await transport.shell(options);
    } catch (error) {
      if (transportLost || transport.closed || isSshError(error, 'DISCONNECTED')) {
        throw new RemoteShellTransportLostError(
          transportError ?? (error instanceof Error ? error : undefined),
        );
      }
      throw error;
    }
  } finally {
    stopWatching();
  }
}

async function tryOpenIntegratedRemoteShell(
  transport: SshTransport,
  getSftp: () => Promise<SftpClient>,
  options: SessionOptions & { pty: PtyRequest },
  cwd?: string,
  probe?: ShellProbeMemo,
): Promise<SshChannel | undefined> {
  try {
    // Do not speculatively open SFTP against console appliances. Many expose
    // only a plain shell channel and some disconnect the whole transport when
    // an unsupported subsystem is requested.
    const shell = await probeShell(transport, probe);
    if (!shell) return undefined;
    const sftp = await getSftp();
    const root = await installIntegration(sftp, shell);
    return await transport.exec(remoteShellCommand(shell, root, cwd), options);
  } catch {
    return undefined;
  }
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

/**
 * The exec command for an integrated shell. `cwd` is the directory a
 * reconnecting tab was last in; the startup files change into it.
 */
export function remoteShellCommand(shell: SupportedShell, root: string, cwd?: string): string {
  const executable = quoteShellWord(shell.path);
  const restoreCwd =
    cwd?.startsWith('/') && !cwd.includes('\0')
      ? `export MUXUS_RESTORE_CWD=${quoteShellWord(cwd)}; `
      : '';
  if (shell.kind === 'bash') {
    return `${restoreCwd}exec ${executable} --noprofile --rcfile ${quoteShellWord(path.posix.join(root, 'bash-init.bash'))} -i`;
  }

  const userZdotdir = shell.zdotdir
    ? `export MUXUS_USER_ZDOTDIR=${quoteShellWord(shell.zdotdir)}; `
    : 'unset MUXUS_USER_ZDOTDIR; ';
  return `${restoreCwd}${userZdotdir}export ZDOTDIR=${quoteShellWord(path.posix.join(root, 'zsh'))}; exec ${executable} -l`;
}

async function probeShell(
  transport: SshTransport,
  memo?: ShellProbeMemo,
): Promise<SupportedShell | undefined> {
  let channel: SshChannel;
  try {
    channel = await transport.exec(SHELL_PROBE);
  } catch (error) {
    if (memo && isSshError(error, 'EXEC_REFUSED')) memo.execRefused = true;
    return undefined;
  }

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Any shell printed the marker, even one Muxus does not integrate.
      if (memo && /^__MUXUS_SHELL__=/m.test(output)) memo.ranCommand = true;
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

async function installIntegration(sftp: SftpClient, shell: SupportedShell): Promise<string> {
  const root = path.posix.join(
    shell.home,
    '.cache',
    'muxus',
    'shell-integration',
    INTEGRATION_VERSION,
  );
  const completePath = path.posix.join(root, INSTALL_COMPLETE);
  const complete = await sftp.stat(completePath).catch(() => undefined);
  if (complete?.isFile()) return root;

  const directories =
    shell.kind === 'zsh' ? [root, path.posix.join(root, 'zsh')] : [root];
  for (const directory of directories) await ensureDirectory(sftp, directory);

  const files = shell.kind === 'zsh'
    ? [
        { path: path.posix.join(root, 'zsh', '.zshenv'), content: ZSHENV },
        { path: path.posix.join(root, 'zsh', '.zprofile'), content: ZPROFILE },
        { path: path.posix.join(root, 'zsh', '.zshrc'), content: REMOTE_ZSHRC },
      ]
    : [{ path: path.posix.join(root, 'bash-init.bash'), content: BASH_INIT }];
  await Promise.all(files.map((file) => sftp.writeFile(file.path, file.content, 0o600)));
  // Written last so interrupted installs are repaired on the next attempt.
  await sftp.writeFile(completePath, INTEGRATION_VERSION, 0o600);
  return root;
}

async function ensureDirectory(sftp: SftpClient, directory: string): Promise<void> {
  const normalized = path.posix.normalize(directory);
  const parts = normalized.split('/').filter(Boolean);
  let current = '/';
  for (const part of parts) {
    current = path.posix.join(current, part);
    const existing = await sftp.stat(current).catch(() => undefined);
    if (existing?.isDirectory()) continue;
    if (existing) throw new Error(`${current} is not a directory`);
    try {
      await sftp.mkdir(current, 0o700);
    } catch (error) {
      // Another terminal may have created it between stat and mkdir.
      const attrs = await sftp.stat(current).catch(() => undefined);
      if (!attrs?.isDirectory()) throw error;
    }
  }
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
