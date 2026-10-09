import { describe, expect, it } from 'vitest';
import {
  droppedPathsText,
  localShellPathStyle,
  quotePath,
  wslPath,
} from '../../../client/src/terminal/drop-paths.js';

describe('quoting dropped paths for POSIX shells', () => {
  it('leaves plain paths alone and single-quotes the rest', () => {
    expect(quotePath('/home/me/notes.txt', 'posix')).toBe('/home/me/notes.txt');
    expect(quotePath('/home/me/Größe_1.0+final@v2,x=y:z', 'posix')).toBe('/home/me/Größe_1.0+final@v2,x=y:z');
    expect(quotePath('/home/me/My Documents/a b.txt', 'posix')).toBe(`'/home/me/My Documents/a b.txt'`);
    expect(quotePath('/tmp/$HOME `id` *.log ~ & | ; ( ) < > ! # ?', 'posix')).toBe(
      `'/tmp/$HOME \`id\` *.log ~ & | ; ( ) < > ! # ?'`,
    );
  });

  it('closes and reopens the quotes around an apostrophe', () => {
    expect(quotePath("/home/me/it's here", 'posix')).toBe(`'/home/me/it'\\''s here'`);
  });

  it('spells control characters out so a newline is never typed as Enter', () => {
    expect(quotePath('/tmp/two\nlines', 'posix')).toBe(`$'/tmp/two\\x0alines'`);
    expect(quotePath("/tmp/tab\there's \\ back", 'posix')).toBe(`$'/tmp/tab\\x09here\\'s \\\\ back'`);
  });
});

describe('quoting dropped paths for fish', () => {
  it('escapes backslashes and apostrophes inside the quotes', () => {
    expect(quotePath('/srv/app/main.go', 'fish')).toBe('/srv/app/main.go');
    expect(quotePath("/srv/it's a\\b", 'fish')).toBe(`'/srv/it\\'s a\\\\b'`);
  });

  it('puts control characters between quoted runs', () => {
    expect(quotePath('/tmp/a\nb c', 'fish')).toBe(`'/tmp/a'\\x0a'b c'`);
  });
});

describe('quoting dropped paths for Windows shells', () => {
  it('single-quotes for PowerShell, doubling every kind of single quote', () => {
    expect(quotePath('C:\\Users\\me\\notes.txt', 'powershell')).toBe('C:\\Users\\me\\notes.txt');
    expect(quotePath('C:\\Program Files\\App $x\\a.txt', 'powershell')).toBe(`'C:\\Program Files\\App $x\\a.txt'`);
    expect(quotePath("C:\\Users\\me\\Bob's \u2019file\u2019.txt", 'powershell')).toBe(
      `'C:\\Users\\me\\Bob''s \u2019\u2019file\u2019\u2019.txt'`,
    );
  });

  it('double-quotes for cmd', () => {
    expect(quotePath('C:\\Users\\me\\notes.txt', 'cmd')).toBe('C:\\Users\\me\\notes.txt');
    expect(quotePath('C:\\Program Files\\a&b.txt', 'cmd')).toBe('"C:\\Program Files\\a&b.txt"');
  });
});

describe('WSL paths', () => {
  it('moves drive paths under /mnt', () => {
    expect(wslPath('C:\\Users\\me\\My file.txt')).toBe('/mnt/c/Users/me/My file.txt');
    expect(wslPath('D:\\')).toBe('/mnt/d/');
    expect(wslPath('e:')).toBe('/mnt/e/');
  });

  it("reads the distribution's own files from its network share", () => {
    expect(wslPath('\\\\wsl$\\Ubuntu\\home\\me\\a.txt', 'Ubuntu')).toBe('/home/me/a.txt');
    expect(wslPath('\\\\wsl.localhost\\Ubuntu\\home\\me', 'ubuntu')).toBe('/home/me');
    expect(wslPath('\\\\wsl.localhost\\Ubuntu', undefined)).toBe('/');
  });

  it("leaves other distributions' and servers' shares as they are", () => {
    expect(wslPath('\\\\wsl$\\Debian\\home\\me', 'Ubuntu')).toBe('\\\\wsl$\\Debian\\home\\me');
    expect(wslPath('\\\\server\\share\\a.txt')).toBe('\\\\server\\share\\a.txt');
  });
});

describe('the shell a local terminal runs', () => {
  it('follows the profile, then the default shell', () => {
    expect(localShellPathStyle({}, '/bin/zsh', 'darwin')).toEqual({ quoting: 'posix' });
    expect(localShellPathStyle({ shell: '/usr/bin/fish' }, '/bin/bash', 'linux')).toEqual({ quoting: 'fish' });
    expect(localShellPathStyle({ shell: ' ' }, '/usr/local/bin/fish', 'linux')).toEqual({ quoting: 'fish' });
    expect(localShellPathStyle({ shell: '/opt/microsoft/powershell/7/pwsh' }, '/bin/bash', 'linux')).toEqual({
      quoting: 'powershell',
    });
  });

  it('tells the Windows shells apart', () => {
    const cmd = 'C:\\Windows\\system32\\cmd.exe';
    expect(localShellPathStyle({}, cmd, 'win32')).toEqual({ quoting: 'cmd' });
    expect(localShellPathStyle({ shell: 'powershell.exe' }, cmd, 'win32')).toEqual({ quoting: 'powershell' });
    expect(
      localShellPathStyle({ shell: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"' }, cmd, 'win32'),
    ).toEqual({ quoting: 'powershell' });
    expect(localShellPathStyle({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }, cmd, 'win32')).toEqual({
      quoting: 'posix',
    });
    expect(localShellPathStyle({ shell: 'nu.exe' }, cmd, 'win32')).toEqual({ quoting: 'cmd' });
  });

  it('recognizes WSL and the distribution it starts', () => {
    const cmd = 'C:\\Windows\\system32\\cmd.exe';
    expect(localShellPathStyle({ shell: 'wsl.exe', args: ['-d', 'Ubuntu', '--cd', '~'] }, cmd, 'win32')).toEqual({
      quoting: 'posix',
      wsl: { distribution: 'Ubuntu' },
    });
    expect(localShellPathStyle({ shell: 'wsl' }, cmd, 'win32')).toEqual({ quoting: 'posix', wsl: {} });
    expect(localShellPathStyle({ shell: 'C:\\Windows\\System32\\bash.exe' }, cmd, 'win32')).toEqual({
      quoting: 'posix',
      wsl: {},
    });
  });
});

describe('the text a drop types', () => {
  it('quotes every path and ends each with a space', () => {
    expect(droppedPathsText(['/a/one.txt', '/a/two words.txt'], { quoting: 'posix' })).toBe(
      `/a/one.txt '/a/two words.txt' `,
    );
  });

  it('rewrites Windows paths for a WSL shell before quoting them', () => {
    expect(
      droppedPathsText(['C:\\Users\\me\\a b.txt', '\\\\wsl$\\Ubuntu\\home\\me\\c.txt'], {
        quoting: 'posix',
        wsl: { distribution: 'Ubuntu' },
      }),
    ).toBe(`'/mnt/c/Users/me/a b.txt' /home/me/c.txt `);
  });
});
