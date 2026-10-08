import type {} from '../../../client/src/desktop.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../client/src/api/http.js';
import { localCopyChanged, type LocalCopySyncDeps } from '../../../client/src/local-copy-sync.js';
import type { ConfirmOptions } from '../../../client/src/state/dialogs.js';
import { useLocalCopiesStore, type TrackedLocalCopy } from '../../../client/src/state/local-copies.js';

declare global {
  interface ImportMeta {
    readonly env: { readonly DEV: boolean };
  }
}

let nextCopy = 1;
const contents = new TextEncoder().encode('<mxfile>edited</mxfile>');

function track(patch: Partial<TrackedLocalCopy> = {}): TrackedLocalCopy {
  const copy: TrackedLocalCopy = {
    id: `copy-${nextCopy++}`,
    connId: 'conn-1',
    remotePath: '/home/deploy/plan.drawio',
    name: 'plan.drawio',
    host: 'web-01',
    remoteMtimeMs: 1_700_000_000_000,
    autoUpload: false,
    ...patch,
  };
  useLocalCopiesStore.getState().track(copy);
  return copy;
}

function harness(answers: Array<boolean | 'always'> = [true]) {
  const asked: ConfirmOptions[] = [];
  const uploads: Array<{ url: string; text: string }> = [];
  const deps = {
    readLocalCopy: vi.fn(async (_id: string, offset: number) =>
      offset === 0 ? contents : new Uint8Array(0),
    ),
    confirm: vi.fn(async (options: ConfirmOptions) => {
      asked.push(options);
      const answer = answers.shift() ?? false;
      if (answer === 'always') options.checkbox?.onChecked();
      return answer !== false;
    }),
    upload: vi.fn(async (url: string, blob: Blob, options: Parameters<LocalCopySyncDeps['upload']>[2]) => {
      uploads.push({ url, text: await blob.text() });
      options.onProgress({ loaded: blob.size, total: blob.size, bytesPerSecond: 100 });
      options.onUploadComplete?.();
      return { ok: true, mtimeMs: 1_700_000_100_000 };
    }),
    refresh: vi.fn(),
    notify: vi.fn(),
    settleMs: 0,
  } satisfies LocalCopySyncDeps;
  return { deps, asked, uploads };
}

beforeEach(() => {
  useLocalCopiesStore.setState({ copies: {}, upload: undefined });
});

describe('uploading saves of files opened locally', () => {
  it('asks, then uploads only over the version that was downloaded', async () => {
    const copy = track();
    const { deps, asked, uploads } = harness([true]);

    await localCopyChanged({ id: copy.id, file: '/tmp/open-1/plan.drawio' }, deps);

    expect(asked[0]).toMatchObject({
      title: 'Upload changes to plan.drawio?',
      description: 'plan.drawio was saved in another program. Uploading replaces /home/deploy/plan.drawio on web-01.',
      confirmLabel: 'Upload',
    });
    expect(uploads).toEqual([
      {
        url: '/api/sftp/conn-1/upload?path=%2Fhome%2Fdeploy%2Fplan.drawio&overwrite=true&expectedMtimeMs=1700000000000',
        text: '<mxfile>edited</mxfile>',
      },
    ]);
    expect(useLocalCopiesStore.getState().copies[copy.id]?.remoteMtimeMs).toBe(1_700_000_100_000);
    expect(deps.refresh).toHaveBeenCalledWith('conn-1');
    expect(deps.notify).toHaveBeenCalledWith('success', 'Uploaded plan.drawio to web-01');
    await vi.waitFor(() => expect(useLocalCopiesStore.getState().upload).toBeUndefined());
  });

  it('uploads nothing when the user declines', async () => {
    const copy = track();
    const { deps, uploads } = harness([false]);
    await localCopyChanged({ id: copy.id, file: '/tmp/plan.drawio' }, deps);
    expect(uploads).toEqual([]);
    expect(deps.readLocalCopy).not.toHaveBeenCalled();
  });

  it('stops asking once the user ticks the box', async () => {
    const copy = track();
    const { deps, asked, uploads } = harness(['always']);
    await localCopyChanged({ id: copy.id, file: '/tmp/plan.drawio' }, deps);
    await localCopyChanged({ id: copy.id, file: '/tmp/plan.drawio' }, deps);

    expect(asked).toHaveLength(1);
    expect(uploads).toHaveLength(2);
    expect(uploads[1]?.url).toContain('expectedMtimeMs=1700000100000');
  });

  it('folds saves made while the question is open into it', async () => {
    const copy = track();
    const { deps, asked, uploads } = harness([true]);
    const first = localCopyChanged({ id: copy.id, file: '/tmp/plan.drawio' }, deps);
    void localCopyChanged({ id: copy.id, file: '/tmp/plan.drawio' }, deps);
    void localCopyChanged({ id: copy.id, file: '/tmp/plan.drawio' }, deps);
    await first;
    expect(asked).toHaveLength(1);
    expect(uploads).toHaveLength(1);
  });

  it('asks before replacing a server file that changed too', async () => {
    const copy = track();
    const { deps, asked, uploads } = harness([true, true]);
    deps.upload.mockImplementationOnce(async () => {
      throw new ApiError(409, 'the remote file changed since it was downloaded', {
        message: 'the remote file changed since it was downloaded',
        code: 'SFTP_FILE_CHANGED',
      });
    });

    await localCopyChanged({ id: copy.id, file: '/tmp/plan.drawio' }, deps);

    expect(asked[1]).toMatchObject({ title: 'plan.drawio also changed on the server', confirmLabel: 'Replace', destructive: true });
    expect(deps.upload).toHaveBeenCalledTimes(2);
    expect(deps.upload.mock.calls[1]?.[0]).not.toContain('expectedMtimeMs');
    expect(uploads).toHaveLength(1);
    expect(deps.notify).toHaveBeenCalledWith('success', 'Uploaded plan.drawio to web-01');
  });

  it("keeps the server's version when the user says so", async () => {
    const copy = track();
    const { deps } = harness([true, false]);
    deps.upload.mockImplementationOnce(async () => {
      throw new ApiError(409, 'changed', { message: 'changed', code: 'SFTP_FILE_CHANGED' });
    });

    await localCopyChanged({ id: copy.id, file: '/tmp/open-1/plan.drawio' }, deps);

    expect(deps.upload).toHaveBeenCalledOnce();
    expect(deps.notify).toHaveBeenCalledWith('info', 'plan.drawio was not uploaded. Your copy is at /tmp/open-1/plan.drawio');
    expect(useLocalCopiesStore.getState().upload).toBeUndefined();
  });

  it('points at the copy when the connection has closed', async () => {
    const copy = track();
    const { deps } = harness([true]);
    deps.upload.mockImplementationOnce(async () => {
      throw new ApiError(404, 'connection not found', { message: 'connection not found' });
    });

    await localCopyChanged({ id: copy.id, file: '/tmp/open-1/plan.drawio' }, deps);

    expect(deps.notify).toHaveBeenCalledWith(
      'error',
      'Could not upload plan.drawio: the connection to web-01 is closed. Reconnect and upload your copy from /tmp/open-1/plan.drawio',
    );
  });

  it('can be cancelled while it uploads', async () => {
    const copy = track();
    const { deps } = harness([true]);
    deps.upload.mockImplementationOnce(
      (_url, _blob, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('Transfer cancelled', 'AbortError')),
          );
          useLocalCopiesStore.getState().upload?.cancel();
        }),
    );

    await localCopyChanged({ id: copy.id, file: '/tmp/plan.drawio' }, deps);

    expect(deps.notify).toHaveBeenCalledWith('info', 'Cancelled the upload of plan.drawio. Your copy is at /tmp/plan.drawio');
    expect(useLocalCopiesStore.getState().upload).toBeUndefined();
  });

  it('ignores copies it was never told about', async () => {
    const { deps } = harness([true]);
    await localCopyChanged({ id: 'unknown', file: '/tmp/x' }, deps);
    expect(deps.confirm).not.toHaveBeenCalled();
  });
});
