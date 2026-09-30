import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WslDistribution } from '@muxus/shared';

/** Where WSL registers each distribution for the current user, one subkey per
 * distribution. Windows Terminal discovers its WSL profiles from here too. */
const LXSS_PATH = 'Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
const LXSS_ROOT = `HKEY_CURRENT_USER\\${LXSS_PATH}`.toLowerCase();

/** Docker Desktop and Rancher Desktop keep their engines in WSL distributions
 * that are not meant to be entered, and Windows Terminal hides them as well. */
const UTILITY_DISTRIBUTION = /^(?:docker-desktop|rancher-desktop)/i;

const REG_KEY_LINE = /^HKEY_[A-Z_]+\\/;
const REG_VALUE_LINE = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/;
// A name that did not survive the console code page, or could not be passed
// to wsl.exe intact, is left out rather than listed and failing to launch.
// oxlint-disable-next-line no-control-regex
const UNUSABLE_NAME = /[\u0000-\u001f\u007f\ufffd]/;

/** Where WSL keeps the icon a distribution ships for its Start menu shortcut
 * and Windows Terminal profile, inside the distribution's own folder. */
const ICON_FILE = 'shortcut.ico';
/** Distribution icons are tens of kilobytes; anything far larger is not one. */
const MAX_ICON_BYTES = 256 * 1024;
const ICO_HEADER = Buffer.from([0, 0, 1, 0]);

/** One registered distribution, with the folder WSL keeps its files in. */
export interface WslRegistration extends Omit<WslDistribution, 'icon'> {
  basePath?: string;
}

/**
 * Parse `reg query <Lxss> /s` output into launchable distributions: the
 * default first, then by name.
 */
export function parseWslRegistry(output: string): WslRegistration[] {
  // Values belong to the Lxss key itself or to one distribution subkey,
  // named by the distribution's GUID; anything else is skipped.
  let id: string | null = null;
  let defaultId: string | undefined;
  const names = new Map<string, string>();
  const basePaths = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    if (REG_KEY_LINE.test(line)) {
      const key = line.trim().toLowerCase();
      const child = key.startsWith(`${LXSS_ROOT}\\`) ? key.slice(LXSS_ROOT.length + 1) : null;
      id = key === LXSS_ROOT ? '' : child && !child.includes('\\') ? child : null;
      continue;
    }
    const match = REG_VALUE_LINE.exec(line);
    if (id === null || !match || match[2] !== 'REG_SZ') continue;
    const [, valueName, , data = ''] = match;
    if (!id && valueName === 'DefaultDistribution') defaultId = data.trim().toLowerCase();
    else if (id && valueName === 'DistributionName') names.set(id, data.trim());
    else if (id && valueName === 'BasePath' && data.trim()) basePaths.set(id, data.trim());
  }

  const seen = new Set<string>();
  const distributions: WslRegistration[] = [];
  for (const [guid, name] of names) {
    const folded = name.toLowerCase();
    if (!name || name.length > 256 || UNUSABLE_NAME.test(name)) continue;
    if (UTILITY_DISTRIBUTION.test(name) || seen.has(folded)) continue;
    seen.add(folded);
    distributions.push({ name, isDefault: guid === defaultId, basePath: basePaths.get(guid) });
  }
  return distributions.sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

function queryLxssKey(): Promise<string> {
  // An absolute path, so a reg.exe in the working directory or on PATH is never run.
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const reg = path.win32.join(systemRoot, 'System32', 'reg.exe');
  return new Promise((resolve, reject) => {
    execFile(
      reg,
      ['query', `HKCU\\${LXSS_PATH}`, '/s'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * The icon a distribution in WSL's own package format ships, as a data
 * URL. WSL copies it into the distribution's folder and points its Start menu
 * shortcut and Windows Terminal profile at it; Store-packaged distributions
 * keep theirs inside the app package and have none here.
 */
export async function readWslDistributionIcon(basePath: string): Promise<string | undefined> {
  const iconPath = path.join(basePath, ICON_FILE);
  try {
    if ((await stat(iconPath)).size > MAX_ICON_BYTES) return undefined;
    const icon = await readFile(iconPath);
    if (!icon.subarray(0, ICO_HEADER.length).equals(ICO_HEADER)) return undefined;
    return `data:image/x-icon;base64,${icon.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/**
 * The WSL distributions installed for the server user. Reading the registry
 * never starts WSL, and on a system without it the key simply does not exist,
 * where the wsl.exe stub could offer to install WSL and wait for a key press.
 */
export async function listWslDistributions(
  platform: NodeJS.Platform = process.platform,
  query: () => Promise<string> = queryLxssKey,
  readIcon: (basePath: string) => Promise<string | undefined> = readWslDistributionIcon,
): Promise<WslDistribution[]> {
  if (platform !== 'win32') return [];
  let registrations: WslRegistration[];
  try {
    registrations = parseWslRegistry(await query());
  } catch {
    // reg.exe exits 1 when the Lxss key is missing: WSL has never been set up.
    return [];
  }
  return Promise.all(
    registrations.map(async ({ basePath, ...distribution }) => {
      const icon = basePath ? await readIcon(basePath) : undefined;
      return icon ? { ...distribution, icon } : distribution;
    }),
  );
}
