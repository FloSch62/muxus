import process from 'node:process';
import { userInfo } from 'node:os';

type Environment = Record<string, string | undefined>;
type ReadLoginEnvironment = () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

async function readLoginShellEnvironment(): Promise<Record<string, string>> {
  const shell = process.env.SHELL || userInfo().shell || '/bin/sh';
  // Bound shell startup and keep it asynchronous: synchronous child-process
  // reads can stall the native application's event loop.
  const child = Bun.spawn([shell, '-ilc', 'printf "\\0_MUXUS_ENV_\\0%s\\0%s\\0" "$PATH" "$SSH_AUTH_SOCK"'], {
    stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', timeout: 3000, killSignal: 'SIGKILL',
    env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', ZSH_TMUX_AUTOSTART: 'false' },
  });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error('Login shell failed or exceeded 3000ms');
  const fields = output.split('\0_MUXUS_ENV_\0')[1]?.split('\0');
  if (!fields) throw new Error('Login shell did not return its environment');
  return { PATH: fields[0] ?? '', SSH_AUTH_SOCK: fields[1] ?? '' };
}

/**
 * GUI launches do not inherit shell startup files. Keep PATH aligned on Unix
 * and, on macOS, import the selected SSH agent socket for 1Password,
 * Secretive, and other agents configured by the user's login shell.
 */
export async function importLoginShellEnvironment(
  platform = process.platform,
  environment: Environment = process.env,
  readLoginEnvironment: ReadLoginEnvironment = readLoginShellEnvironment,
  onError?: (err: unknown) => void,
): Promise<void> {
  if (platform === 'win32') return;

  let loginEnvironment: Readonly<Record<string, string>>;
  try {
    loginEnvironment = await readLoginEnvironment();
  } catch (err) {
    // A broken login shell means PATH and SSH_AUTH_SOCK stay at launch values
    // — connections may fail later; leave a trace of why.
    onError?.(err);
    return;
  }

  if (loginEnvironment.PATH) environment.PATH = loginEnvironment.PATH;
  if (platform === 'darwin' && loginEnvironment.SSH_AUTH_SOCK) {
    environment.SSH_AUTH_SOCK = loginEnvironment.SSH_AUTH_SOCK;
  }
}
