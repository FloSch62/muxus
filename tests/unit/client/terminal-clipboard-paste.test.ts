import { describe, expect, it, vi } from 'vitest';
import {
  pasteTerminalClipboard,
  remoteClipboardImagePath,
} from '../../../client/src/terminal/clipboard-paste.js';

describe('terminal clipboard paste', () => {
  it('pastes clipboard text without reading or uploading an image', async () => {
    const readImagePng = vi.fn();
    const uploadImage = vi.fn();
    const pasteText = vi.fn();

    await expect(
      pasteTerminalClipboard({
        readText: async () => 'echo hello',
        readImagePng,
        uploadImage,
        pasteText,
      }),
    ).resolves.toEqual({ status: 'pasted', kind: 'text' });
    expect(pasteText).toHaveBeenCalledWith('echo hello');
    expect(readImagePng).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('uploads an image-only clipboard and pastes its remote path', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const pasteText = vi.fn();
    const uploadImage = vi.fn(async () => '/tmp/muxus-paste.png');

    await expect(
      pasteTerminalClipboard({
        readText: async () => '',
        readImagePng: async () => png,
        uploadImage,
        pasteText,
      }),
    ).resolves.toEqual({ status: 'pasted', kind: 'image-path' });
    expect(uploadImage).toHaveBeenCalledWith(png);
    expect(pasteText).toHaveBeenCalledWith('/tmp/muxus-paste.png');
  });

  it('reports unavailable clipboard access when neither text nor image can be read', async () => {
    await expect(
      pasteTerminalClipboard({
        readText: async () => null,
        readImagePng: async () => undefined,
        uploadImage: vi.fn(),
        pasteText: vi.fn(),
      }),
    ).resolves.toEqual({ status: 'skipped', reason: 'unavailable' });
  });

  it('does not hide image upload failures', async () => {
    const failure = new Error('SFTP is disabled');
    await expect(
      pasteTerminalClipboard({
        readText: async () => '',
        readImagePng: async () => new Uint8Array([1]),
        uploadImage: async () => {
          throw failure;
        },
        pasteText: vi.fn(),
      }),
    ).rejects.toBe(failure);
  });

  it('creates a collision-resistant PNG path in the remote temp directory', () => {
    expect(remoteClipboardImagePath(1234, 'fixed-id')).toBe(
      '/tmp/muxus-paste-1234-fixed-id.png',
    );
  });
});
