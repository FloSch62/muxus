import { describe, expect, it } from 'vitest';
import {
  localShellLaunchArguments,
  opensWslDistribution,
  parseLocalShellArgumentText,
  wslShellProfile,
  wslShellProfiles,
} from '../../../client/src/local-shell-profile.js';

describe('local shell profile arguments', () => {
  it('preserves trailing and intermediate blank rows while editing', () => {
    expect(parseLocalShellArgumentText('-d\n')).toEqual(['-d', '']);
    expect(parseLocalShellArgumentText('-d\n\nUbuntu')).toEqual(['-d', '', 'Ubuntu']);
  });

  it('discards blank editor rows only when launching', () => {
    expect(localShellLaunchArguments(['-d', '', 'Ubuntu', ''])).toEqual([
      '-d',
      'Ubuntu',
    ]);
    expect(localShellLaunchArguments([''])).toBeUndefined();
  });
});

describe('installed WSL distributions', () => {
  const saved = (shell: string, args: string[]) => ({
    id: `saved-${shell}-${args.join('-')}`,
    name: 'Saved',
    shell,
    args,
    cwd: '',
    startupCommand: '',
  });

  it('opens a distribution in its Linux home directory', () => {
    expect(wslShellProfile({ name: 'Ubuntu-24.04', isDefault: true })).toEqual({
      id: 'wsl:Ubuntu-24.04',
      name: 'Ubuntu-24.04',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu-24.04', '--cd', '~'],
      cwd: '',
      startupCommand: '',
    });
  });

  it('recognises a saved profile that already starts the distribution', () => {
    expect(opensWslDistribution(saved('wsl.exe', ['-d', 'Ubuntu']), 'ubuntu')).toBe(true);
    expect(opensWslDistribution(saved('WSL', ['--distribution', 'Ubuntu']), 'Ubuntu')).toBe(
      true,
    );
    expect(
      opensWslDistribution(saved('C:\\Windows\\System32\\wsl.exe', ['-d', 'Ubuntu']), 'Ubuntu'),
    ).toBe(true);
    expect(opensWslDistribution(saved('wsl.exe', ['-d', 'Debian']), 'Ubuntu')).toBe(false);
    expect(opensWslDistribution(saved('wsl.exe', []), 'Ubuntu')).toBe(false);
    expect(opensWslDistribution(saved('pwsh.exe', ['-d', 'Ubuntu']), 'Ubuntu')).toBe(false);
  });

  it('offers only the distributions no saved profile covers', () => {
    expect(
      wslShellProfiles(
        [
          { name: 'Ubuntu', isDefault: true },
          { name: 'Debian', isDefault: false },
        ],
        [saved('wsl.exe', ['-d', 'Ubuntu'])],
      ).map((profile) => profile.name),
    ).toEqual(['Debian']);
  });
});
