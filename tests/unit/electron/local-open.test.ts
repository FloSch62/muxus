import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalCopy,
  launchEnvironment,
  LOCAL_COPY_MAX_AGE_MS,
  localCopyFileName,
  purgeStaleLocalCopies,
  runOpener,
  startDetached,
} from '../../../electron/src/local-open.js';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function scratch(): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), 'muxus-open-test-'));
  return root;
}

describe('local copy names', () => {
  it('keeps ordinary remote names intact', () => {
    expect(localCopyFileName('plan.drawio')).toBe('plan.drawio');
    expect(localCopyFileName('Quarterly report (final).pdf')).toBe('Quarterly report (final).pdf');
    expect(localCopyFileName('übersicht.html')).toBe('übersicht.html');
  });

  it('never lets a name leave its folder or break on Windows', () => {
    expect(localCopyFileName('../../etc/passwd')).toBe('passwd');
    expect(localCopyFileName('..\\..\\boot.ini')).toBe('boot.ini');
    expect(localCopyFileName('..')).toBe('file');
    expect(localCopyFileName('')).toBe('file');
    expect(localCopyFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(localCopyFileName('tab\there\u0001.txt')).toBe('tab_here_.txt');
    expect(localCopyFileName('notes. . ')).toBe('notes');
    expect(localCopyFileName('CON')).toBe('_CON');
    expect(localCopyFileName('lpt1.log')).toBe('_lpt1.log');
    expect(localCopyFileName('console.log')).toBe('console.log');
  });

  it('shortens long names but keeps the extension that picks the program', () => {
    const name = localCopyFileName(`${'x'.repeat(300)}.drawio`);
    expect(name.length).toBe(180);
    expect(name.endsWith('.drawio')).toBe(true);
  });
});

describe('local copies', () => {
  it('gives every copy a private folder so the remote name can repeat', async () => {
    const directory = await scratch();
    const copyRoot = path.join(directory, 'muxus-open');
    const first = await createLocalCopy(copyRoot, 'index.html');
    const second = await createLocalCopy(copyRoot, 'index.html');
    await first.handle.writeFile('one');
    await first.handle.close();
    await second.handle.close();

    expect(first.directory).not.toBe(second.directory);
    expect(path.basename(first.file)).toBe('index.html');
    expect(path.dirname(first.file)).toBe(first.directory);
    expect(await readFile(first.file, 'utf8')).toBe('one');
    if (process.platform !== 'win32') {
      expect((await stat(copyRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(first.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(first.file)).mode & 0o077).toBe(0);
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a root others can write to', async () => {
    const directory = await scratch();
    const shared = path.join(directory, 'muxus-open');
    await mkdir(shared);
    await chmod(shared, 0o777);
    await expect(createLocalCopy(shared, 'index.html')).rejects.toThrow(/not a private folder/);
    expect(await readdir(shared)).toEqual([]);
  });

  it('removes only copies left alone for longer than the limit', async () => {
    const directory = await scratch();
    const now = Date.now();
    const stale = new Date(now - LOCAL_COPY_MAX_AGE_MS - 60_000);
    const make = async (name: string, folderTime: Date, fileTime: Date) => {
      await mkdir(path.join(directory, name));
      await writeFile(path.join(directory, name, 'file.txt'), name);
      await utimes(path.join(directory, name, 'file.txt'), fileTime, fileTime);
      await utimes(path.join(directory, name), folderTime, folderTime);
    };
    await make('open-old', stale, stale);
    await make('open-recent', new Date(now), new Date(now));
    // Saved again by the program that opened it: the file is recent.
    await make('open-edited', stale, new Date(now));
    await make('other-old', stale, stale);
    await writeFile(path.join(directory, 'open-file'), '');

    await purgeStaleLocalCopies(directory, now);

    expect((await readdir(directory)).toSorted()).toEqual([
      'open-edited',
      'open-file',
      'open-recent',
      'other-old',
    ]);
  });

  it('tolerates a missing root', async () => {
    await expect(purgeStaleLocalCopies(path.join(tmpdir(), 'muxus-open-missing-root'))).resolves.toBeUndefined();
  });
});

describe('launching programs', () => {
  it("drops Electron's own variables from launched programs", () => {
    expect(
      launchEnvironment({
        PATH: '/usr/bin',
        CHROME_DESKTOP: 'muxus.desktop',
        GDK_BACKEND: 'wayland',
        NO_AT_BRIDGE: '1',
        XDG_CURRENT_DESKTOP: 'Unity',
        ORIGINAL_XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      }),
    ).toEqual({ PATH: '/usr/bin', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' });
  });

  it('reports how an opener exited', async () => {
    await expect(runOpener(process.execPath, ['-e', 'process.exit(0)'])).resolves.toBeUndefined();
    await expect(runOpener(process.execPath, ['-e', 'process.exit(4)'])).rejects.toThrow(/exited with 4/);
    await expect(runOpener(path.join(tmpdir(), 'muxus-no-such-opener'), [])).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stops waiting for an opener that keeps running', async () => {
    await expect(
      runOpener(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 50 }),
    ).resolves.toBeUndefined();
  });

  it('starts a detached program with the file', async () => {
    const directory = await scratch();
    const marker = path.join(directory, 'marker');
    await startDetached(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "opened")', marker]);
    await expect
      .poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 5_000 })
      .toBe('opened');
    await expect(startDetached(path.join(directory, 'missing'), [])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
