import { homedir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/** Retain the installed desktop profile, including vault IDs and WAL databases. */
export function installedUserDataPath(): string {
  const home = homedir();
  const base = process.platform === 'darwin' ? path.join(home, 'Library/Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData/Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'Muxus');
}

export function isDevelopmentBuild(): boolean {
  try {
    const { channel } = JSON.parse(readFileSync(path.resolve('../Resources/version.json'), 'utf8'));
    return channel !== 'stable' && channel !== 'canary';
  } catch { return true; }
}

export function userDataPath(): string {
  if (process.env.MUXUS_DESKTOP_DATA) return path.resolve(process.env.MUXUS_DESKTOP_DATA);
  return installedUserDataPath() + (isDevelopmentBuild() ? '-development' : '');
}
