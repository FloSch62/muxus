import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listWslDistributions,
  parseWslRegistry,
  readWslDistributionIcon,
} from '../../../server/src/local/wsl.js';

const ROOT = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
const UBUNTU = '{3f4e1a2b-7c5d-4e6f-8a9b-0c1d2e3f4a5b}';
const DEBIAN = '{9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d}';
const DOCKER = '{11111111-2222-4333-8444-555555555555}';
const UBUNTU_STORE_PATH =
  'C:\\Users\\dev\\AppData\\Local\\Packages\\CanonicalGroupLimited.Ubuntu24.04LTS\\LocalState';
const DEBIAN_PATH = `C:\\Users\\dev\\AppData\\Local\\wsl\\${DEBIAN}`;

/** `reg query <Lxss> /s` as Windows prints it: CRLF lines, four-space columns. */
function regOutput(lines: string[]): string {
  return ['', ...lines, '', 'End of search: 12 match(es) found.', ''].join('\r\n');
}

const INSTALLED = regOutput([
  ROOT,
  `    DefaultDistribution    REG_SZ    ${DEBIAN.toUpperCase()}`,
  '    DefaultVersion    REG_DWORD    0x2',
  '',
  `${ROOT}\\${UBUNTU}`,
  '    State    REG_DWORD    0x1',
  '    DistributionName    REG_SZ    Ubuntu-24.04',
  '    Version    REG_DWORD    0x2',
  `    BasePath    REG_SZ    ${UBUNTU_STORE_PATH}`,
  '    DefaultEnvironment    REG_MULTI_SZ    HOSTTYPE=x86_64\\0LANG=en_US.UTF-8',
  '',
  `${ROOT}\\${DOCKER}`,
  '    DistributionName    REG_SZ    docker-desktop',
  '',
  `${ROOT}\\${DEBIAN}`,
  '    DistributionName    REG_SZ    Debian',
  `    BasePath    REG_SZ    ${DEBIAN_PATH}`,
  '    Modern    REG_DWORD    0x1',
  '',
  `${ROOT}\\{22222222-3333-4444-8555-666666666666}`,
  '    DistributionName    REG_SZ    Ubuntu',
  '',
  `${ROOT}\\${UBUNTU}\\Nested`,
  '    DistributionName    REG_SZ    also-not-one',
]);

describe('WSL distribution discovery', () => {
  it('lists every registered distribution, the default first', () => {
    expect(parseWslRegistry(INSTALLED)).toEqual([
      { name: 'Debian', isDefault: true, basePath: DEBIAN_PATH },
      { name: 'Ubuntu', isDefault: false },
      { name: 'Ubuntu-24.04', isDefault: false, basePath: UBUNTU_STORE_PATH },
    ]);
  });

  it('hides the Docker Desktop and Rancher Desktop engine distributions', () => {
    const names = parseWslRegistry(
      regOutput([
        `${ROOT}\\${DOCKER}`,
        '    DistributionName    REG_SZ    docker-desktop-data',
        `${ROOT}\\${UBUNTU}`,
        '    DistributionName    REG_SZ    rancher-desktop',
        `${ROOT}\\${DEBIAN}`,
        '    DistributionName    REG_SZ    Debian',
      ]),
    ).map((distribution) => distribution.name);
    expect(names).toEqual(['Debian']);
  });

  it('skips names that are empty, garbled or duplicated', () => {
    const names = parseWslRegistry(
      regOutput([
        `${ROOT}\\${UBUNTU}`,
        '    DistributionName    REG_SZ    ',
        `${ROOT}\\${DEBIAN}`,
        '    DistributionName    REG_SZ    Arch\ufffd',
        `${ROOT}\\${DOCKER}`,
        '    DistributionName    REG_SZ    Alpine',
        `${ROOT}\\{22222222-3333-4444-8555-666666666666}`,
        '    DistributionName    REG_SZ    alpine',
      ]),
    ).map((distribution) => distribution.name);
    expect(names).toEqual(['Alpine']);
  });

  it('lists distributions when the Lxss key has no values of its own', () => {
    expect(
      parseWslRegistry(
        regOutput([`${ROOT}\\${UBUNTU}`, '    DistributionName    REG_SZ    Ubuntu']),
      ),
    ).toEqual([{ name: 'Ubuntu', isDefault: false }]);
  });

  it('never queries the registry off Windows', async () => {
    const query = vi.fn(async () => INSTALLED);
    await expect(listWslDistributions('linux', query)).resolves.toEqual([]);
    await expect(listWslDistributions('darwin', query)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('reports nothing when WSL has never been set up', async () => {
    // reg.exe exits 1 when the key does not exist.
    const query = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: reg.exe query'), { code: 1 });
    });
    await expect(listWslDistributions('win32', query)).resolves.toEqual([]);
  });

  it('parses the registry on Windows', async () => {
    const distributions = await listWslDistributions(
      'win32',
      async () => INSTALLED,
      async () => undefined,
    );
    expect(distributions[0]).toStrictEqual({ name: 'Debian', isDefault: true });
  });

  it('attaches the icon each distribution ships, without its folder', async () => {
    const readIcon = vi.fn(async (basePath: string) =>
      basePath === DEBIAN_PATH ? 'data:image/x-icon;base64,AAABAA==' : undefined,
    );
    const distributions = await listWslDistributions('win32', async () => INSTALLED, readIcon);
    expect(distributions).toStrictEqual([
      { name: 'Debian', isDefault: true, icon: 'data:image/x-icon;base64,AAABAA==' },
      { name: 'Ubuntu', isDefault: false },
      { name: 'Ubuntu-24.04', isDefault: false },
    ]);
    expect(readIcon.mock.calls.map(([basePath]) => basePath).sort()).toEqual(
      [DEBIAN_PATH, UBUNTU_STORE_PATH].sort(),
    );
  });
});

describe('WSL distribution icons', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'muxus-wsl-icon-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('reads the shortcut icon WSL keeps in the distribution folder', async () => {
    const icon = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]);
    await writeFile(path.join(folder, 'shortcut.ico'), icon);
    await expect(readWslDistributionIcon(folder)).resolves.toBe(
      `data:image/x-icon;base64,${icon.toString('base64')}`,
    );
  });

  it('has no icon for a folder without one', async () => {
    await expect(readWslDistributionIcon(folder)).resolves.toBeUndefined();
    await expect(readWslDistributionIcon(path.join(folder, 'missing'))).resolves.toBeUndefined();
  });

  it('ignores a file that is not an icon, or far too large to be one', async () => {
    await writeFile(path.join(folder, 'shortcut.ico'), '<svg/>');
    await expect(readWslDistributionIcon(folder)).resolves.toBeUndefined();

    const huge = Buffer.alloc(512 * 1024);
    huge.set([0, 0, 1, 0]);
    await writeFile(path.join(folder, 'shortcut.ico'), huge);
    await expect(readWslDistributionIcon(folder)).resolves.toBeUndefined();
  });
});
