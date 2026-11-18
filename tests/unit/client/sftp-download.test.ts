import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadResume,
  forgetInterruptedDownload,
  localFileName,
  numberedFileName,
  pickDownloadFolder,
  saveIntoFolder,
  TRANSFER_CANCELLED,
} from '../../../client/src/sftp-download.js';

/** A folder in memory with the parts of FileSystemDirectoryHandle the download uses. */
function memoryFolder(existing: Record<string, 'file' | 'directory'> = {}) {
  const written = new Map<string, string>();
  const kinds = new Map(Object.entries(existing));
  const folder = {
    name: 'Downloads',
    async getFileHandle(name: string, options?: { create?: boolean }) {
      const kind = kinds.get(name);
      if (kind === 'directory') throw new DOMException('A directory', 'TypeMismatchError');
      if (!kind && !options?.create) throw new DOMException('Missing', 'NotFoundError');
      kinds.set(name, 'file');
      return {
        async createWritable() {
          let content = '';
          return {
            async write(blob: Blob) {
              content += await blob.text();
            },
            async close() {
              written.set(name, content);
            },
            async abort() {},
          };
        },
      };
    },
  };
  return { folder: folder as unknown as FileSystemDirectoryHandle, written };
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
    expect(await pickDownloadFolder()).toBeUndefined();
  });

  it('asks for a writable folder and reports a dismissed picker as null', async () => {
    const { folder } = memoryFolder();
    const showDirectoryPicker = vi.fn(async () => folder);
    vi.stubGlobal('window', { showDirectoryPicker });

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
