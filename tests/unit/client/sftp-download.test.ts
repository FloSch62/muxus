import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localFileName,
  numberedFileName,
  pickDownloadFolder,
  saveIntoFolder,
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
