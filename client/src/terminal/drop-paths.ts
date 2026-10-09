/**
 * Dropped files typed into a terminal as paths, quoted for the shell that
 * reads them: one word per path, separated and followed by a space, the way
 * desktop terminals insert them.
 */

/** How a shell reads a quoted word. */
export type ShellQuoting = 'posix' | 'fish' | 'powershell' | 'cmd';

export interface DroppedPathStyle {
  quoting: ShellQuoting;
  /**
   * The shell runs inside WSL: Windows paths are rewritten to where that
   * distribution sees them. No distribution means the default one.
   */
  wsl?: { distribution?: string };
}

const POSIX_SAFE = /^[\p{L}\p{N}_@%+=:,./-]+$/u;
const WINDOWS_SAFE = /^[\p{L}\p{N}_:\\/.-]+$/u;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// oxlint-disable-next-line no-control-regex
const CONTROL_RUNS = /([\u0000-\u001f\u007f]+)/;
// oxlint-disable-next-line no-control-regex
const EVERY_CONTROL = /[\u0000-\u001f\u007f]/g;

function executableName(shell: string): string {
  const unquoted = shell.trim().replace(/^"(.*)"$/, '$1');
  return (unquoted.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '');
}

function wslDistribution(args: readonly string[]): string | undefined {
  const index = args.findIndex((argument) => argument === '-d' || argument === '--distribution');
  return index === -1 ? undefined : args[index + 1];
}

/**
 * The quoting a local shell profile needs. `defaultShell` is what the server
 * starts when the profile names none; `platform` is the server's.
 */
export function localShellPathStyle(
  launch: { shell?: string; args?: readonly string[] },
  defaultShell: string,
  platform: string,
): DroppedPathStyle {
  const shell = launch.shell?.trim() || defaultShell;
  const name = executableName(shell);
  if (name === 'pwsh' || name === 'powershell') return { quoting: 'powershell' };
  if (name === 'fish') return { quoting: 'fish' };
  if (platform !== 'win32') return { quoting: 'posix' };
  if (name === 'cmd') return { quoting: 'cmd' };
  if (name === 'wsl') {
    const distribution = wslDistribution(launch.args ?? []);
    return { quoting: 'posix', wsl: distribution ? { distribution } : {} };
  }
  // bash.exe in System32 (or found there first) is the WSL launcher; Git Bash,
  // MSYS2 and Cygwin shells read Windows paths themselves.
  if (name === 'bash' && (!/[\\/]/.test(shell) || /[\\/]system32[\\/]bash(?:\.exe)?$/i.test(shell))) {
    return { quoting: 'posix', wsl: {} };
  }
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh'].includes(name)) return { quoting: 'posix' };
  return { quoting: 'cmd' };
}

/** Where a WSL distribution sees a Windows path, e.g. `C:\Users` → `/mnt/c/Users`. */
export function wslPath(path: string, distribution?: string): string {
  const drive = /^([a-z]):(?:[\\/](.*))?$/i.exec(path);
  if (drive) {
    const rest = (drive[2] ?? '').replaceAll('\\', '/');
    return `/mnt/${drive[1]!.toLowerCase()}/${rest}`;
  }
  const share = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(\\.*)?$/i.exec(path);
  if (share && (!distribution || share[1]!.toLowerCase() === distribution.toLowerCase())) {
    return (share[2] ?? '\\').replaceAll('\\', '/');
  }
  return path;
}

function hex(char: string): string {
  return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
}

function quotePosix(path: string): string {
  if (POSIX_SAFE.test(path)) return path;
  if (!CONTROL.test(path)) return `'${path.replaceAll("'", `'\\''`)}'`;
  // A newline or tab inside plain quotes would reach the shell as typed input.
  let quoted = '';
  for (const char of path) {
    if (char === '\\' || char === "'") quoted += `\\${char}`;
    else quoted += CONTROL.test(char) ? hex(char) : char;
  }
  return `$'${quoted}'`;
}

function quoteFish(path: string): string {
  if (POSIX_SAFE.test(path)) return path;
  // fish has no escapes inside quotes but joins adjacent words, so control
  // characters go between quoted runs as escapes.
  return path
    .split(CONTROL_RUNS)
    .filter(Boolean)
    .map((run) =>
      CONTROL.test(run)
        ? run.replace(EVERY_CONTROL, hex)
        : `'${run.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`,
    )
    .join('');
}

function quotePowerShell(path: string): string {
  if (WINDOWS_SAFE.test(path)) return path;
  // PowerShell also closes a single-quoted string on the typographic quotes.
  return `'${path.replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
}

function quoteCmd(path: string): string {
  // Windows file names cannot contain double quotes.
  return WINDOWS_SAFE.test(path) ? path : `"${path}"`;
}

export function quotePath(path: string, quoting: ShellQuoting): string {
  switch (quoting) {
    case 'posix':
      return quotePosix(path);
    case 'fish':
      return quoteFish(path);
    case 'powershell':
      return quotePowerShell(path);
    case 'cmd':
      return quoteCmd(path);
  }
}

/** The text a drop types: every path quoted, each followed by a space. */
export function droppedPathsText(paths: readonly string[], style: DroppedPathStyle): string {
  return paths
    .map((path) => quotePath(style.wsl ? wslPath(path, style.wsl.distribution) : path, style.quoting))
    .map((word) => `${word} `)
    .join('');
}
