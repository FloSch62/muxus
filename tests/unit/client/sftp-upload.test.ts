import type {} from '../../../client/src/desktop.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../client/src/api/http.js';
import {
  collectDrop,
  uploadSummary,
  uploadToRemote,
  type DropPayload,
  type UploadDeps,
  type UploadProgress,
} from '../../../client/src/sftp-upload.js';
import type { ConfirmOptions } from '../../../client/src/state/dialogs.js';
import { useSftpUploadsStore } from '../../../client/src/state/sftp-uploads.js';
import { startTerminalUpload } from '../../../client/src/terminal-upload.js';

declare global {
  interface ImportMeta {
    readonly env: { readonly DEV: boolean };
  }
}

function file(name: string, text: string): File {
  return new File([text], name);
}

function payload(files: Array<[string, string]>, directories: string[] = []): DropPayload {
  return {
    files: files.map(([relativePath, text]) => ({ file: file(relativePath.split('/').at(-1)!, text), relativePath })),
    directories,
  };
}

/** Remote files that already exist answer the first, non-overwriting upload with a conflict. */
function harness(existing: string[] = [], answers: boolean[] = []) {
  const calls: string[] = [];
  const asked: ConfirmOptions[] = [];
  const deps: UploadDeps = {
    mkdir: vi.fn(async (connId: string, path: string) => {
      calls.push(`mkdir ${connId} ${path}`);
    }),
    upload: vi.fn(async (url: string, blob: Blob, options: Parameters<UploadDeps['upload']>[2]) => {
      const target = decodeURIComponent(new URL(url, 'http://muxus').searchParams.get('path') ?? '');
      const overwrite = url.endsWith('&overwrite=true');
      if (existing.includes(target) && !overwrite) {
        throw new ApiError(409, 'a file already exists at the upload destination', {
          message: 'a file already exists at the upload destination',
          code: 'SFTP_DESTINATION_EXISTS',
        });
      }
      calls.push(`upload ${target}${overwrite ? ' (replace)' : ''} ${await blob.text()}`);
      options.onProgress({ loaded: blob.size, total: blob.size, bytesPerSecond: 10 });
      options.onUploadComplete?.();
      return { ok: true };
    }),
    confirm: vi.fn(async (options: ConfirmOptions) => {
      asked.push(options);
      return answers.shift() ?? false;
    }),
  };
  return { deps, calls, asked };
}

describe('uploading a drop over SFTP', () => {
  it('creates folders shallowest first, then uploads every file below the directory', async () => {
    const { deps, calls } = harness();
    const progress: UploadProgress[] = [];
    const result = await uploadToRemote(
      'conn-1',
      '/srv/app',
      payload([['notes.txt', 'n'], ['site/css/main.css', 'body{}'], ['site/index.html', '<p>']], ['site/empty']),
      { signal: new AbortController().signal, onProgress: (update) => progress.push(update), deps },
    );

    expect(calls).toEqual([
      'mkdir conn-1 /srv/app/site',
      'mkdir conn-1 /srv/app/site/empty',
      'mkdir conn-1 /srv/app/site/css',
      'upload /srv/app/notes.txt n',
      'upload /srv/app/site/css/main.css body{}',
      'upload /srv/app/site/index.html <p>',
    ]);
    expect(result).toEqual({ uploaded: 3, directories: 3 });
    expect(progress[0]).toMatchObject({ phase: 'preparing', fileIndex: 0, fileCount: 3, total: 10 });
    expect(progress).toContainEqual(expect.objectContaining({ phase: 'transferring', name: 'site/css/main.css', fileIndex: 2 }));
    expect(progress.at(-1)).toMatchObject({ phase: 'complete', loaded: 10, fileIndex: 3, fileCount: 3 });
  });

  it('uploads into the root directory without doubling the slash', async () => {
    const { deps, calls } = harness();
    await uploadToRemote('conn-1', '/', payload([['a.txt', 'a']]), {
      signal: new AbortController().signal,
      onProgress: () => undefined,
      deps,
    });
    expect(calls).toEqual(['upload /a.txt a']);
  });

  it('replaces an existing file only after confirmation, and skips it otherwise', async () => {
    const { deps, calls, asked } = harness(['/srv/a.txt', '/srv/b.txt'], [true, false]);
    const result = await uploadToRemote('conn-1', '/srv', payload([['a.txt', 'A'], ['b.txt', 'B'], ['c.txt', 'C']]), {
      signal: new AbortController().signal,
      onProgress: () => undefined,
      deps,
    });

    expect(asked.map((options) => options.description)).toEqual([
      'a.txt already exists on the remote host.',
      'b.txt already exists on the remote host.',
    ]);
    expect(asked[0]).toMatchObject({ title: 'Replace the existing file?', confirmLabel: 'Replace', destructive: true });
    expect(calls).toEqual(['upload /srv/a.txt (replace) A', 'upload /srv/c.txt C']);
    expect(result).toEqual({ uploaded: 2, directories: 0 });
  });

  it('stops at the next file once cancelled while asking to replace', async () => {
    const controller = new AbortController();
    const { deps, calls } = harness(['/srv/a.txt']);
    deps.confirm = vi.fn(async () => {
      controller.abort();
      return true;
    });
    await expect(
      uploadToRemote('conn-1', '/srv', payload([['a.txt', 'A'], ['b.txt', 'B']]), {
        signal: controller.signal,
        onProgress: () => undefined,
        deps,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  it('keeps file names from climbing out of the directory', async () => {
    const { deps, calls } = harness();
    await uploadToRemote('conn-1', '/srv', payload([['../../etc/passwd', 'x']]), {
      signal: new AbortController().signal,
      onProgress: () => undefined,
      deps,
    });
    expect(calls).toEqual(['mkdir conn-1 /srv/etc', 'upload /srv/etc/passwd x']);
  });

  it('summarizes what happened', () => {
    expect(uploadSummary({ uploaded: 1, directories: 0 })).toBe('Uploaded 1 file');
    expect(uploadSummary({ uploaded: 3, directories: 1 }, '/srv/app')).toBe('Uploaded 3 files to /srv/app');
    expect(uploadSummary({ uploaded: 0, directories: 2 }, '/srv')).toBe('Created 2 folders in /srv');
    expect(uploadSummary({ uploaded: 0, directories: 0 })).toBe('Nothing was uploaded');
  });
});

interface FakeEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (success: (file: File) => void) => void;
  createReader: () => { readEntries: (success: (entries: FakeEntry[]) => void) => void };
}

function entry(name: string, children?: FakeEntry[]): FakeEntry {
  let read = false;
  return {
    isFile: !children,
    isDirectory: !!children,
    name,
    file: (success) => success(file(name, name)),
    createReader: () => ({
      readEntries: (success) => {
        success(read ? [] : (children ?? []));
        read = true;
      },
    }),
  };
}

function item(value: FakeEntry | null, fallback?: File): DataTransferItem {
  return {
    webkitGetAsEntry: () => value,
    getAsFile: () => fallback ?? null,
  } as unknown as DataTransferItem;
}

describe('reading a drop', () => {
  it('walks dropped folders, keeping empty ones', async () => {
    const dropped = await collectDrop([
      item(entry('report.pdf')),
      item(entry('project', [entry('README.md'), entry('src', [entry('main.go')]), entry('empty', [])])),
    ]);
    expect(dropped.files.map(({ relativePath }) => relativePath).sort()).toEqual([
      'project/README.md',
      'project/src/main.go',
      'report.pdf',
    ]);
    expect(dropped.directories.sort()).toEqual(['project', 'project/empty', 'project/src']);
  });

  it('falls back to plain files where entries are unavailable', async () => {
    const dropped = await collectDrop([item(null, file('a.txt', 'a')), item(null)]);
    expect(dropped).toEqual({ files: [{ file: expect.any(File), relativePath: 'a.txt' }], directories: [] });
  });
});

describe('uploads started from a terminal', () => {
  beforeEach(() => {
    useSftpUploadsStore.setState({ uploads: {}, browsers: {} });
  });

  it('shows progress for the connection, then reports where the files went', async () => {
    const { deps, calls } = harness();
    const notify = vi.fn();
    const refresh = vi.fn();
    const seen: string[] = [];
    const unsubscribe = useSftpUploadsStore.subscribe((state) => {
      const upload = state.uploads['conn-1'];
      if (upload && seen.at(-1) !== upload.phase) seen.push(upload.phase);
    });

    await startTerminalUpload({
      connId: 'conn-1',
      host: 'web-01',
      prepare: async () => ({ directory: '/home/admin', payload: payload([['a.txt', 'a']]) }),
      refresh,
      deps,
      notify,
      settleMs: 0,
    });
    unsubscribe();

    expect(calls).toEqual(['upload /home/admin/a.txt a']);
    expect(seen).toEqual(['preparing', 'transferring', 'finalizing', 'complete']);
    expect(useSftpUploadsStore.getState().uploads['conn-1']).toMatchObject({ host: 'web-01', phase: 'complete' });
    expect(refresh).toHaveBeenCalledWith('conn-1');
    expect(notify).toHaveBeenCalledWith('success', 'Uploaded 1 file to /home/admin');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useSftpUploadsStore.getState().uploads).toEqual({});
  });

  it('runs one upload per connection at a time', async () => {
    const { deps } = harness();
    const notify = vi.fn();
    let release!: () => void;
    const first = startTerminalUpload({
      connId: 'conn-1',
      prepare: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { directory: '/srv', payload: payload([['a.txt', 'a']]) };
      },
      refresh: vi.fn(),
      deps,
      notify,
      settleMs: 0,
    });
    await startTerminalUpload({
      connId: 'conn-1',
      prepare: async () => ({ directory: '/srv', payload: payload([['b.txt', 'b']]) }),
      refresh: vi.fn(),
      deps,
      notify,
    });
    expect(notify).toHaveBeenCalledWith('warning', 'Wait for the current upload to finish.');
    release();
    await first;
    expect(notify).toHaveBeenLastCalledWith('success', 'Uploaded 1 file to /srv');
  });

  it('does not wait for a finished upload that is still on screen', async () => {
    const { deps, calls } = harness();
    const notify = vi.fn();
    const request = (name: string) => ({
      connId: 'conn-1',
      prepare: async () => ({ directory: '/srv', payload: payload([[name, name]]) }),
      refresh: vi.fn(),
      deps,
      notify,
      settleMs: 60_000,
    });
    await startTerminalUpload(request('a.txt'));
    expect(useSftpUploadsStore.getState().uploads['conn-1']?.phase).toBe('complete');
    await startTerminalUpload(request('b.txt'));
    expect(calls).toEqual(['upload /srv/a.txt a.txt', 'upload /srv/b.txt b.txt']);
    expect(notify).not.toHaveBeenCalledWith('warning', expect.anything());
  });

  it('can be cancelled while the drop is still being read', async () => {
    const notify = vi.fn();
    const upload = startTerminalUpload({
      connId: 'conn-1',
      prepare: (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))),
        ),
      refresh: vi.fn(),
      deps: harness().deps,
      notify,
    });
    useSftpUploadsStore.getState().uploads['conn-1']!.cancel();
    expect(useSftpUploadsStore.getState().uploads['conn-1']?.phase).toBe('cancelling');
    await upload;
    expect(notify).toHaveBeenCalledWith('info', 'Upload cancelled');
    expect(useSftpUploadsStore.getState().uploads).toEqual({});
  });

  it('reports a failed upload as an error and clears its progress', async () => {
    const deps = harness().deps;
    deps.upload = vi.fn(async () => {
      throw new ApiError(404, 'connection not found', { message: 'connection not found' });
    });
    const notify = vi.fn();
    await startTerminalUpload({
      connId: 'conn-1',
      prepare: async () => ({ directory: '/srv', payload: payload([['a.txt', 'a']]) }),
      refresh: vi.fn(),
      deps,
      notify,
    });
    expect(notify).toHaveBeenCalledWith('error', 'connection not found', expect.stringContaining('HTTP 404'));
    expect(useSftpUploadsStore.getState().uploads).toEqual({});
  });

  it('counts the file browsers showing a connection', () => {
    const { attachBrowser } = useSftpUploadsStore.getState();
    const first = attachBrowser('conn-1');
    const second = attachBrowser('conn-1');
    expect(useSftpUploadsStore.getState().browsers).toEqual({ 'conn-1': 2 });
    first();
    first();
    expect(useSftpUploadsStore.getState().browsers).toEqual({ 'conn-1': 1 });
    second();
    expect(useSftpUploadsStore.getState().browsers).toEqual({});
  });
});
