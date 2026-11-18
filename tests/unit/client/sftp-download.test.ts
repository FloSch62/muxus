import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SftpEntry, SftpEntryType } from '@muxus/shared';
import { ApiError } from '../../../client/src/api/http.js';
import {
  canPickDownloadFolder,
  downloadFromRemote,
  downloadResume,
  downloadSummary,
  forgetInterruptedDownload,
  localFileName,
  MAX_FOLDER_DOWNLOAD_BYTES,
  MAX_FOLDER_DOWNLOAD_ENTRIES,
  numberedFileName,
  pickDownloadFolder,
  saveIntoFolder,
  type DownloadDeps,
  type DownloadProgress,
} from '../../../client/src/sftp-download.js';
import type { ConfirmOptions } from '../../../client/src/state/dialogs.js';
import { CONNECTION_LOST, TRANSFER_CANCELLED } from '../../../client/src/transfer-progress.js';

/**
 * A folder in memory with the parts of FileSystemDirectoryHandle the download
 * uses. Paths below it use `/`; `written` holds what was saved. Names in
 * `refused` are turned down as Chromium turns down aux.c in a local folder.
 */
function memoryFolder(existing: Record<string, 'file' | 'directory'> = {}, refused: string[] = []) {
  const written = new Map<string, string>();
  const kinds = new Map(Object.entries(existing));
  const check = (name: string) => {
    if (refused.includes(name)) {
      throw new TypeError("Failed to execute 'getFileHandle' on 'FileSystemDirectoryHandle': Name is not allowed.");
    }
  };
  const folderAt = (prefix: string, name: string) => ({
    name,
    async getFileHandle(child: string, options?: { create?: boolean }) {
      check(child);
      const path = prefix + child;
      const kind = kinds.get(path);
      if (kind === 'directory') throw new DOMException('A directory', 'TypeMismatchError');
      if (!kind && !options?.create) throw new DOMException('Missing', 'NotFoundError');
      kinds.set(path, 'file');
      return {
        async createWritable() {
          let content = '';
          return {
            async write(blob: Blob) {
              content += await blob.text();
            },
            async close() {
              written.set(path, content);
            },
            async abort() {},
          };
        },
      };
    },
    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      check(child);
      const path = prefix + child;
      const kind = kinds.get(path);
      if (kind === 'file') throw new DOMException('A file', 'TypeMismatchError');
      if (!kind && !options?.create) throw new DOMException('Missing', 'NotFoundError');
      kinds.set(path, 'directory');
      return folderAt(`${path}/`, child);
    },
  });
  const created = () =>
    [...kinds].filter(([path, kind]) => kind === 'directory' && !(path in existing)).map(([path]) => path);
  return { folder: folderAt('', 'Downloads') as unknown as FileSystemDirectoryHandle, written, created };
}

describe('saving downloads into a folder', () => {
  it('writes the file under its own name', async () => {
    const { folder, written } = memoryFolder();

    expect(await saveIntoFolder(folder, 'report.txt', new Blob(['payload']))).toBe('report.txt');
    expect(written.get('report.txt')).toBe('payload');
  });

  it('numbers a name that is taken instead of replacing what is there', async () => {
    const { folder, written } = memoryFolder({ 'report.txt': 'file', 'report (1).txt': 'directory' });

    expect(await saveIntoFolder(folder, 'report.txt', new Blob(['new']))).toBe('report (2).txt');
    expect([...written.keys()]).toEqual(['report (2).txt']);
  });

  it('cleans remote names that local file systems refuse', async () => {
    const { folder, written } = memoryFolder();

    expect(await saveIntoFolder(folder, 'show run: 10/24?.txt', new Blob(['x']))).toBe('show run_ 10_24_.txt');
    expect(written.has('show run_ 10_24_.txt')).toBe(true);
  });
});

describe('download file names', () => {
  it('numbers before the extension and after a dotfile', () => {
    expect(numberedFileName('report.txt', 0)).toBe('report.txt');
    expect(numberedFileName('report.txt', 3)).toBe('report (3).txt');
    expect(numberedFileName('.bashrc', 1)).toBe('.bashrc (1)');
    expect(numberedFileName('Makefile', 1)).toBe('Makefile (1)');
  });

  it('replaces separators, reserved and control characters, and trailing dots', () => {
    expect(localFileName('a\\b|c*"d"<e>')).toBe('a_b_c__d__e_');
    expect(localFileName('tab\there')).toBe('tab_here');
    expect(localFileName('notes. ')).toBe('notes');
    expect(localFileName('..')).toBe('download');
  });
});

describe('picking the download folder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is unavailable where the page cannot write to a folder', async () => {
    vi.stubGlobal('window', {});
    expect(canPickDownloadFolder()).toBe(false);
    expect(await pickDownloadFolder()).toBeUndefined();
  });

  it('asks for a writable folder and reports a dismissed picker as null', async () => {
    const { folder } = memoryFolder();
    const showDirectoryPicker = vi.fn(async () => folder);
    vi.stubGlobal('window', { showDirectoryPicker });

    expect(canPickDownloadFolder()).toBe(true);
    expect(await pickDownloadFolder()).toBe(folder);
    expect(showDirectoryPicker).toHaveBeenCalledWith(expect.objectContaining({ mode: 'readwrite' }));

    showDirectoryPicker.mockRejectedValueOnce(new DOMException('Dismissed', 'AbortError'));
    expect(await pickDownloadFolder()).toBeNull();
  });
});

describe('continuing interrupted downloads', () => {
  const used = new Set<string>();
  const resume = (file: string, signal = new AbortController().signal) => {
    used.add(file);
    return downloadResume(file, signal);
  };
  const partial = (text: string) => ({ blob: new Blob([text]), etag: '"v1"' });

  afterEach(() => {
    for (const file of used) forgetInterruptedDownload(file);
    used.clear();
  });

  it('offers what a broken download received to the next download of the file', () => {
    const first = resume('/srv/a.iso');
    expect(first.partial).toBeUndefined();
    const kept = partial('abc');
    first.onInterrupted(kept);

    expect(resume('/srv/a.iso').partial).toBe(kept);
    expect(resume('/srv/other.iso').partial).toBeUndefined();

    forgetInterruptedDownload('/srv/a.iso');
    expect(resume('/srv/a.iso').partial).toBeUndefined();
  });

  it('keeps a download stopped by the file browser closing, and drops a cancelled one', () => {
    const closing = new AbortController();
    const closed = resume('/srv/a.iso', closing.signal);
    closing.abort();
    const kept = partial('abc');
    closed.onInterrupted(kept);
    expect(resume('/srv/a.iso').partial).toBe(kept);

    const cancelling = new AbortController();
    const cancelled = resume('/srv/a.iso', cancelling.signal);
    cancelling.abort(TRANSFER_CANCELLED);
    cancelled.onInterrupted(partial('abcdef'));
    expect(resume('/srv/a.iso').partial).toBeUndefined();
  });

  it('drops what was kept when Cancel comes before the server answers', () => {
    resume('/srv/a.iso').onInterrupted(partial('abc'));

    const cancelling = new AbortController();
    resume('/srv/a.iso', cancelling.signal);
    cancelling.abort(TRANSFER_CANCELLED);

    expect(resume('/srv/a.iso').partial).toBeUndefined();
  });

  it('leaves the file alone on a Cancel that comes after it was released', () => {
    const cancelling = new AbortController();
    resume('/srv/a.iso', cancelling.signal).release();
    const kept = partial('abc');
    resume('/srv/a.iso').onInterrupted(kept);
    cancelling.abort(TRANSFER_CANCELLED);

    expect(resume('/srv/a.iso').partial).toBe(kept);
  });

  it('keeps the newest within 256 MiB, and nothing larger', () => {
    const MiB = 1024 * 1024;
    // Only the size is read; a real 256 MiB blob is not needed.
    const sized = (size: number) => ({ blob: { size } as Blob, etag: '"v1"' });
    for (const [file, size] of [['/srv/1.iso', 100], ['/srv/2.iso', 100], ['/srv/3.iso', 100]] as const) {
      resume(file).onInterrupted(sized(size * MiB));
    }
    resume('/srv/huge.iso').onInterrupted(sized(257 * MiB));

    expect(['/srv/1.iso', '/srv/2.iso', '/srv/3.iso', '/srv/huge.iso'].map((file) => !!resume(file).partial))
      .toEqual([false, true, true, false]);
  });
});

type RemoteEntry = [name: string, type: SftpEntryType, size?: number];

/** Remote folders by path. A file holds its own path, which is also its size unless given. */
function remote(
  folders: Record<string, RemoteEntry[]>,
  { resolved = {}, answer = true }: { resolved?: Record<string, string>; answer?: boolean } = {},
) {
  const calls: string[] = [];
  const asked: ConfirmOptions[] = [];
  const saved: string[] = [];
  const toEntry = (folder: string, [name, type, size]: RemoteEntry): SftpEntry => ({
    name,
    type,
    ...(type === 'file' ? { size: size ?? `${folder}/${name}`.length } : {}),
  });
  const deps: DownloadDeps = {
    list: vi.fn(async (_connId: string, path: string) => {
      calls.push(`list ${path}`);
      const listing = folders[path];
      if (!listing) throw new ApiError(404, 'No such file');
      return { path: resolved[path] ?? path, entries: listing.map((entry) => toEntry(path, entry)) };
    }),
    download: vi.fn(async (...args: Parameters<DownloadDeps['download']>) => {
      const [url, onProgress, , , resume] = args;
      const path = new URL(url, 'http://muxus').searchParams.get('path') ?? '';
      // A continued download asks for the rest and resolves with the whole file.
      const offset = resume?.partial?.blob.size;
      calls.push(offset ? `download ${path} from byte ${offset}` : `download ${path}`);
      onProgress({ loaded: path.length, total: path.length, bytesPerSecond: 10 });
      return new Blob([path]);
    }),
    confirm: vi.fn(async (question: ConfirmOptions) => {
      asked.push(question);
      return answer;
    }),
    save: vi.fn((name: string) => {
      saved.push(name);
    }),
  };
  /** A row of the listing of /srv, as selected in the file browser. */
  const target = (name: string, type: SftpEntryType) => ({ entry: toEntry('/srv', [name, type]), path: `/srv/${name}` });
  return { deps, calls, asked, saved, target };
}

const quietly = (deps: DownloadDeps, signal = new AbortController().signal) => ({
  signal,
  onProgress: () => undefined,
  deps,
});

describe('downloading folders', () => {
  it('recreates folders below the picked one, empty ones included, beside the selected files', async () => {
    const { folder, written, created } = memoryFolder();
    const { deps, calls, asked, target } = remote({
      '/srv/logs': [['app.log', 'file'], ['2024', 'dir'], ['empty', 'dir']],
      '/srv/logs/2024': [['jan.log', 'file']],
      '/srv/logs/empty': [],
    });
    const progress: DownloadProgress[] = [];

    const result = await downloadFromRemote('conn-1', [target('notes.txt', 'file'), target('logs', 'dir')], folder, {
      signal: new AbortController().signal,
      onProgress: (update) => progress.push(update),
      deps,
    });

    expect(calls).toEqual([
      'list /srv/logs',
      'list /srv/logs/2024',
      'list /srv/logs/empty',
      'download /srv/notes.txt',
      'download /srv/logs/app.log',
      'download /srv/logs/2024/jan.log',
    ]);
    expect(created()).toEqual(['logs', 'logs/2024', 'logs/empty']);
    expect(Object.fromEntries(written)).toEqual({
      'notes.txt': '/srv/notes.txt',
      'logs/app.log': '/srv/logs/app.log',
      'logs/2024/jan.log': '/srv/logs/2024/jan.log',
    });
    expect(asked).toEqual([
      { title: 'Download 3 files (53 B)?', description: '3 folders are created in Downloads.', confirmLabel: 'Download' },
    ]);
    expect(result).toEqual({ downloaded: 3, fileCount: 3, folders: 3, skipped: [], cancelled: false });
    expect(progress).toContainEqual(expect.objectContaining({ phase: 'preparing', name: 'logs/2024' }));
    expect(progress).toContainEqual(
      expect.objectContaining({ phase: 'transferring', name: 'logs/2024/jan.log', loaded: 53, total: 53, fileIndex: 3, fileCount: 3 }),
    );
    expect(progress.at(-1)).toMatchObject({ phase: 'complete', name: '3 files', loaded: 53, fileIndex: 3, fileCount: 3 });
  });

  it('numbers a folder whose name is taken instead of merging into it', async () => {
    const { folder, written, created } = memoryFolder({ logs: 'directory', 'logs/app.log': 'file', 'logs (1)': 'file' });
    const { deps, target } = remote({ '/srv/logs': [['app.log', 'file']] });

    await downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps));

    expect(created()).toEqual(['logs (2)']);
    expect(Object.fromEntries(written)).toEqual({ 'logs (2)/app.log': '/srv/logs/app.log' });
  });

  it('skips links and special files without following them, and names them', async () => {
    const { folder, written } = memoryFolder();
    const { deps, calls, asked, target } = remote({
      '/srv/logs': [['app.log', 'file'], ['current', 'link'], ['events', 'other']],
    });

    const result = await downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps));

    expect(calls).toEqual(['list /srv/logs', 'download /srv/logs/app.log']);
    expect(result?.skipped).toEqual(['logs/current (link)', 'logs/events (special file)']);
    expect(asked[0]?.description).toBe('1 folder is created in Downloads. 2 items are skipped.');
    expect([...written.keys()]).toEqual(['logs/app.log']);
  });

  it('skips names that are not a single entry, and keeps everything in the picked folder', async () => {
    const { folder, written, created } = memoryFolder();
    const { deps, calls, saved, target } = remote({
      '/srv/logs': [
        ['ok.txt', 'file'],
        ['nosuchdir/evil.sh', 'file'],
        ['../outside.txt', 'file'],
        ['x/y', 'dir'],
        ['..', 'dir'],
        ['', 'file'],
        ['a\0b', 'file'],
      ],
    });

    const result = await downloadFromRemote('conn-1', [target('logs', 'dir'), target('a/b', 'file')], folder, quietly(deps));

    expect(calls).toEqual(['list /srv/logs', 'download /srv/logs/ok.txt']);
    expect(result?.skipped).toEqual([
      'a/b (invalid name)',
      'logs/nosuchdir/evil.sh (invalid name)',
      'logs/../outside.txt (invalid name)',
      'logs/x/y (invalid name)',
      'logs/.. (invalid name)',
      'logs/ (invalid name)',
      'logs/a\0b (invalid name)',
    ]);
    expect(Object.fromEntries(written)).toEqual({ 'logs/ok.txt': '/srv/logs/ok.txt' });
    expect(created()).toEqual(['logs']);
    expect(saved).toEqual([]);
  });

  it('skips names the local folder refuses, with what is inside such a folder, and goes on', async () => {
    const { folder, written, created } = memoryFolder({}, ['aux.c', 'con']);
    const { deps, calls, target } = remote({
      '/srv/linux': [['aux.c', 'file'], ['con', 'dir'], ['main.c', 'file']],
      '/srv/linux/con': [['inside.c', 'file']],
    });

    const result = await downloadFromRemote('conn-1', [target('linux', 'dir')], folder, quietly(deps));

    expect(calls).toEqual(['list /srv/linux', 'list /srv/linux/con', 'download /srv/linux/aux.c', 'download /srv/linux/main.c']);
    expect(created()).toEqual(['linux']);
    expect(Object.fromEntries(written)).toEqual({ 'linux/main.c': '/srv/linux/main.c' });
    expect(result).toEqual({
      downloaded: 1,
      fileCount: 2,
      folders: 1,
      skipped: ['linux/con (name not allowed locally)', 'linux/aux.c (name not allowed locally)'],
      cancelled: false,
    });
  });

  it('skips a folder that leads back to one already listed', async () => {
    // A server that reports links with their target's attributes lists them as folders.
    const { folder, created } = memoryFolder();
    const { deps, calls, target } = remote(
      { '/srv/logs': [['app.log', 'file'], ['loop', 'dir']], '/srv/logs/loop': [['app.log', 'file'], ['loop', 'dir']] },
      { resolved: { '/srv/logs/loop': '/srv/logs' } },
    );

    const result = await downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps));

    expect(calls).toEqual(['list /srv/logs', 'list /srv/logs/loop', 'download /srv/logs/app.log']);
    expect(result).toMatchObject({ downloaded: 1, folders: 1, skipped: ['logs/loop (link)'] });
    expect(created()).toEqual(['logs']);
  });

  it('refuses folders past the limits before saving anything', async () => {
    const { folder, created } = memoryFolder();
    const crowded = remote({
      '/srv/logs': Array.from({ length: MAX_FOLDER_DOWNLOAD_ENTRIES }, (_, index): RemoteEntry => [`${index}.log`, 'file']),
    });
    const large = remote({ '/srv/images': [['a.bin', 'file', MAX_FOLDER_DOWNLOAD_BYTES], ['b.bin', 'file', 1]] });

    await expect(
      downloadFromRemote('conn-1', [crowded.target('logs', 'dir')], folder, quietly(crowded.deps)),
    ).rejects.toThrow(`More than ${MAX_FOLDER_DOWNLOAD_ENTRIES.toLocaleString()} files and folders to download.`);
    await expect(
      downloadFromRemote('conn-1', [large.target('images', 'dir')], folder, quietly(large.deps)),
    ).rejects.toThrow('More than 10 GiB to download.');
    for (const { deps } of [crowded, large]) {
      expect(deps.confirm).not.toHaveBeenCalled();
      expect(deps.download).not.toHaveBeenCalled();
    }
    expect(created()).toEqual([]);
  });

  it('stops on a folder that cannot be listed, naming it, before saving anything', async () => {
    const { folder, created } = memoryFolder();
    const { deps, target } = remote({ '/srv/logs': [['private', 'dir']] });

    const error = await downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps))
      .catch((stopped: unknown) => stopped);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: 'Could not list logs/private: No such file' });
    expect(created()).toEqual([]);
  });

  it('saves nothing when the question is declined', async () => {
    const { folder, written, created } = memoryFolder();
    const { deps, target } = remote({ '/srv/logs': [['app.log', 'file']] }, { answer: false });

    expect(await downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps))).toBeUndefined();
    expect(deps.download).not.toHaveBeenCalled();
    expect(created()).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('downloads files alone without asking', async () => {
    const { folder, written } = memoryFolder();
    const { deps, target } = remote({});

    await downloadFromRemote('conn-1', [target('a.txt', 'file'), target('b.txt', 'file')], folder, quietly(deps));

    expect(deps.confirm).not.toHaveBeenCalled();
    expect([...written.keys()]).toEqual(['a.txt', 'b.txt']);
  });

  it('hands files to the browser downloads without a picked folder, and leaves folders out', async () => {
    const { deps, saved, target } = remote({ '/srv/logs': [['app.log', 'file']] });

    const result = await downloadFromRemote(
      'conn-1',
      [target('a.txt', 'file'), target('logs', 'dir'), target('b.txt', 'file')],
      undefined,
      quietly(deps),
    );

    expect(saved).toEqual(['a.txt', 'b.txt']);
    expect(deps.list).not.toHaveBeenCalled();
    expect(result).toEqual({ downloaded: 2, fileCount: 2, folders: 0, skipped: [], cancelled: false });
  });
});

describe('stopping and continuing a folder download', () => {
  const logs: Record<string, RemoteEntry[]> = { '/srv/logs': [['a.log', 'file'], ['b.log', 'file'], ['c.log', 'file']] };
  const part = (text: string) => ({ blob: new Blob([text]), etag: '"v1"' });
  const keep = (file: string, text: string) => downloadResume(file, new AbortController().signal).onInterrupted(part(text));
  const kept = (file: string) => downloadResume(file, new AbortController().signal).partial;

  /** Downloading b.log stops after its first bytes, with the error `stop` returns. */
  function stopAtSecondFile(deps: DownloadDeps, stop: () => unknown) {
    const download = deps.download;
    deps.download = vi.fn(async (...args: Parameters<DownloadDeps['download']>) => {
      if (!args[0].includes('b.log')) return download(...args);
      const error = stop();
      args[4]?.onInterrupted(part('/srv/'));
      throw error;
    });
  }

  afterEach(() => {
    for (const name of ['a.log', 'b.log', 'c.log']) forgetInterruptedDownload(`/srv/logs/${name}`);
  });

  it('continues a file from what an interrupted download received, and forgets it once saved', async () => {
    keep('/srv/logs/b.log', '/srv/logs/');
    const { folder, written } = memoryFolder();
    const { deps, calls, target } = remote(logs);

    await downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps));

    expect(calls).toEqual([
      'list /srv/logs',
      'download /srv/logs/a.log',
      'download /srv/logs/b.log from byte 10',
      'download /srv/logs/c.log',
    ]);
    expect(written.get('logs/b.log')).toBe('/srv/logs/b.log');
    expect(kept('/srv/logs/b.log')).toBeUndefined();
  });

  it('keeps what was saved after Cancel, says how far it got, and drops what the file received', async () => {
    keep('/srv/logs/b.log', '/srv/logs/');
    const controller = new AbortController();
    const { folder, written } = memoryFolder();
    const { deps, target } = remote(logs);
    stopAtSecondFile(deps, () => {
      controller.abort(TRANSFER_CANCELLED);
      return TRANSFER_CANCELLED;
    });

    const result = await downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps, controller.signal));

    expect(result).toEqual({ downloaded: 1, fileCount: 3, folders: 1, skipped: [], cancelled: true });
    expect([...written.keys()]).toEqual(['logs/a.log']);
    expect(deps.download).toHaveBeenCalledTimes(2);
    expect(kept('/srv/logs/b.log')).toBeUndefined();
  });

  it.each([
    ['the file browser closes', (controller: AbortController) => controller.abort()],
    ['the connection is lost', (controller: AbortController) => controller.abort(CONNECTION_LOST)],
  ])('rejects with the abort when %s, keeping what the file received', async (_, abort) => {
    const controller = new AbortController();
    const { folder, written } = memoryFolder();
    const { deps, target } = remote(logs);
    stopAtSecondFile(deps, () => {
      abort(controller);
      // What fetch rejects with.
      return controller.signal.reason;
    });

    const error = await downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps, controller.signal))
      .catch((stopped: unknown) => stopped);

    expect(error).toBe(controller.signal.reason);
    expect([...written.keys()]).toEqual(['logs/a.log']);
    expect(await kept('/srv/logs/b.log')?.blob.text()).toBe('/srv/');
  });

  it('rejects with a failure, naming the file and keeping what it received', async () => {
    const { folder, written } = memoryFolder();
    const { deps, target } = remote(logs);
    stopAtSecondFile(deps, () => new TypeError('network error'));

    await expect(downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps))).rejects.toThrow(
      'Could not download logs/b.log: network error',
    );
    expect([...written.keys()]).toEqual(['logs/a.log']);
    expect(await kept('/srv/logs/b.log')?.blob.text()).toBe('/srv/');
  });

  it('names a file or folder the picked folder does not take', async () => {
    const refusal = new DOMException('The request is not allowed.', 'NotAllowedError');
    const forFiles = memoryFolder();
    vi.spyOn(forFiles.folder, 'getFileHandle').mockRejectedValue(refusal);
    const forFolders = memoryFolder();
    vi.spyOn(forFolders.folder, 'getDirectoryHandle').mockRejectedValue(refusal);
    const { deps, target } = remote({ '/srv/logs': [] });

    await expect(
      downloadFromRemote('conn-1', [target('a.txt', 'file'), target('b.txt', 'file')], forFiles.folder, quietly(deps)),
    ).rejects.toThrow('Could not save a.txt: The request is not allowed.');
    expect(deps.download).toHaveBeenCalledTimes(1);
    await expect(downloadFromRemote('conn-1', [target('logs', 'dir')], forFolders.folder, quietly(deps))).rejects.toThrow(
      'Could not create logs: The request is not allowed.',
    );
  });

  it('stops creating folders after Cancel, and says how many it created', async () => {
    const controller = new AbortController();
    const { folder, created } = memoryFolder();
    const { deps, target } = remote({ '/srv/a': [], '/srv/b': [], '/srv/c': [['c.log', 'file']] });
    const create = folder.getDirectoryHandle.bind(folder);
    vi.spyOn(folder, 'getDirectoryHandle').mockImplementation(async (...args) => {
      controller.abort(TRANSFER_CANCELLED);
      return create(...args);
    });

    const result = await downloadFromRemote(
      'conn-1',
      ['a', 'b', 'c'].map((name) => target(name, 'dir')),
      folder,
      quietly(deps, controller.signal),
    );

    expect(created()).toEqual(['a']);
    expect(deps.download).not.toHaveBeenCalled();
    expect(result).toEqual({ downloaded: 0, fileCount: 0, folders: 1, skipped: [], cancelled: true });
    expect(downloadSummary(result!, folder.name)).toBe('Download cancelled: 1 folder created in Downloads');
  });

  it('leaves the files it finished alone when cancelled later', async () => {
    const controller = new AbortController();
    const { folder } = memoryFolder();
    const { deps, target } = remote(logs);
    const download = deps.download;
    deps.download = vi.fn(async (...args: Parameters<DownloadDeps['download']>) => {
      if (!args[0].includes('c.log')) return download(...args);
      // Meanwhile another file browser in the window was cut off while downloading a.log.
      keep('/srv/logs/a.log', '/srv/');
      controller.abort(TRANSFER_CANCELLED);
      throw TRANSFER_CANCELLED;
    });

    const result = await downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps, controller.signal));

    expect(result).toMatchObject({ downloaded: 2, cancelled: true });
    expect(await kept('/srv/logs/a.log')?.blob.text()).toBe('/srv/');
  });

  it('stops before saving anything when the connection is lost while asking', async () => {
    const controller = new AbortController();
    const { folder, created } = memoryFolder();
    const { deps, target } = remote(logs);
    deps.confirm = vi.fn(async () => {
      controller.abort(CONNECTION_LOST);
      return true;
    });

    await expect(
      downloadFromRemote('conn-1', [target('logs', 'dir')], folder, quietly(deps, controller.signal)),
    ).rejects.toBe(CONNECTION_LOST);
    expect(created()).toEqual([]);
    expect(deps.download).not.toHaveBeenCalled();
  });
});

describe('download summaries', () => {
  const nothing = { downloaded: 0, fileCount: 0, folders: 0, skipped: [], cancelled: false };

  it('says what was saved, where, and what was left out', () => {
    expect(downloadSummary({ ...nothing, downloaded: 3, fileCount: 3 }, 'Downloads')).toBe('Downloaded 3 files to Downloads');
    expect(downloadSummary({ ...nothing, downloaded: 1, fileCount: 1, folders: 1, skipped: ['logs/current (link)'] })).toBe(
      'Downloaded 1 file; 1 item skipped',
    );
    expect(downloadSummary({ ...nothing, folders: 2 }, 'Downloads')).toBe('Created 2 folders in Downloads');
    expect(downloadSummary(nothing)).toBe('Nothing was downloaded');
  });

  it('says how far a cancelled download got', () => {
    expect(downloadSummary({ ...nothing, downloaded: 12, fileCount: 47, folders: 6, cancelled: true }, 'Downloads')).toBe(
      'Download cancelled: 12 of 47 files saved in Downloads',
    );
    expect(downloadSummary({ ...nothing, fileCount: 47, folders: 3, cancelled: true }, 'Downloads')).toBe(
      'Download cancelled: 3 folders created in Downloads',
    );
    expect(downloadSummary({ ...nothing, fileCount: 47, cancelled: true })).toBe('Download cancelled');
  });
});
