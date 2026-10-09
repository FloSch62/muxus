import { describe, expect, it } from 'vitest';
import type { FileTransferState } from '@muxus/shared';
import {
  FILE_TRANSFER_OPTIONS,
  remoteCommandHint,
  supportsFileTransfer,
  toProgressState,
  transferLabel,
  transferOutcome,
  unsavedFiles,
} from '../../../client/src/terminal/file-transfer.js';

function state(patch: Partial<FileTransferState> = {}): FileTransferState {
  return {
    id: 't1',
    direction: 'receive',
    protocol: 'zmodem',
    phase: 'transferring',
    automatic: true,
    bytes: 0,
    bytesPerSecond: 0,
    received: [],
    ...patch,
  };
}

describe('terminal file transfers', () => {
  it('is offered on serial, Telnet and SSH terminals only', () => {
    expect(['ssh', 'telnet', 'serial'].every((kind) => supportsFileTransfer({ kind: kind as 'ssh' }))).toBe(true);
    expect(supportsFileTransfer({ kind: 'local' })).toBe(false);
    expect(supportsFileTransfer({ kind: 'rdp' })).toBe(false);
    expect(supportsFileTransfer(undefined)).toBe(false);
  });

  it('lists every protocol, and only YMODEM and ZMODEM carry names and batches', () => {
    expect(FILE_TRANSFER_OPTIONS.map((option) => option.protocol)).toEqual([
      'xmodem',
      'xmodem-crc',
      'xmodem-1k',
      'ymodem',
      'zmodem',
    ]);
    expect(FILE_TRANSFER_OPTIONS.filter((option) => option.batch).map((option) => option.protocol)).toEqual([
      'ymodem',
      'zmodem',
    ]);
    expect(FILE_TRANSFER_OPTIONS.filter((option) => option.needsName).map((option) => option.protocol)).toEqual([
      'xmodem',
      'xmodem-crc',
      'xmodem-1k',
    ]);
    expect(remoteCommandHint('send', 'ymodem')).toMatch(/loady/);
    expect(remoteCommandHint('send', 'zmodem')).toMatch(/types rz/);
  });

  it('labels the progress bar with file, direction, host and protocol', () => {
    expect(transferLabel(state({ fileName: 'fw.img' }), 'router')).toBe('Receiving fw.img from router with ZMODEM');
    expect(transferLabel(state({ direction: 'send', protocol: 'ymodem', fileName: 'fw.img' }), 'router')).toBe(
      'Sending fw.img to router with YMODEM',
    );
    expect(transferLabel(state({ phase: 'waiting', direction: 'send', protocol: 'xmodem-1k' }), 'router')).toBe(
      'Waiting for router to start receiving (XMODEM-1K)…',
    );
    expect(transferLabel(state({ phase: 'cancelling' }), 'router')).toBe('Cancelling the ZMODEM transfer…');
  });

  it('maps transfer state onto the shared progress bar', () => {
    expect(
      toProgressState(
        state({ direction: 'send', fileName: 'a', bytes: 10, total: 20, bytesPerSecond: 5, fileIndex: 2, fileCount: 3 }),
      ),
    ).toEqual({
      direction: 'upload',
      name: 'a',
      loaded: 10,
      total: 20,
      bytesPerSecond: 5,
      phase: 'transferring',
      fileIndex: 2,
      fileCount: 3,
    });
    expect(toProgressState(state({ phase: 'waiting' })).phase).toBe('preparing');
    expect(toProgressState(state({ phase: 'cancelling' })).phase).toBe('cancelling');
  });

  it('saves each received file once', () => {
    const received = [
      { id: 'a', name: 'one', size: 1 },
      { id: 'b', name: 'two', size: 2 },
    ];
    expect(unsavedFiles(state({ received }), new Set(['a']))).toEqual([received[1]]);
  });

  it('words the outcome', () => {
    expect(transferOutcome(state({ phase: 'complete', received: [{ id: 'a', name: 'f.bin', size: 1 }] }))).toEqual({
      severity: 'success',
      message: 'Received f.bin with ZMODEM',
    });
    expect(
      transferOutcome(state({ phase: 'complete', direction: 'send', fileCount: 1, fileName: 'f.bin', skipped: ['f.bin'] })),
    ).toMatchObject({ severity: 'warning', message: expect.stringMatching(/skipped f\.bin.*already exists/) });
    expect(transferOutcome(state({ phase: 'cancelled', message: 'Declined.' })).message).toBe(
      'Declined the ZMODEM transfer',
    );
    expect(transferOutcome(state({ phase: 'failed', protocol: 'xmodem', message: 'The remote side stopped responding.' }))).toEqual({
      severity: 'error',
      message: 'XMODEM transfer failed: The remote side stopped responding.',
    });
  });
});
