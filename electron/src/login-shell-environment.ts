import process from 'node:process';
import { shellEnvSync } from 'shell-env';

type Environment = Record<string, string | undefined>;
type ReadLoginEnvironment = () => Readonly<Record<string, string>>;

/**
 * GUI launches do not inherit shell startup files. Keep PATH aligned on Unix
 * and, on macOS, import the selected SSH agent socket for 1Password,
 * Secretive, and other agents configured by the user's login shell.
 */
export function importLoginShellEnvironment(
  platform = process.platform,
  environment: Environment = process.env,
  readLoginEnvironment: ReadLoginEnvironment = shellEnvSync,
): void {
  if (platform === 'win32') return;

  let loginEnvironment: Readonly<Record<string, string>>;
  try {
    loginEnvironment = readLoginEnvironment();
  } catch {
    return;
  }

  if (loginEnvironment.PATH) environment.PATH = loginEnvironment.PATH;
  if (platform === 'darwin' && loginEnvironment.SSH_AUTH_SOCK) {
    environment.SSH_AUTH_SOCK = loginEnvironment.SSH_AUTH_SOCK;
  }
}
