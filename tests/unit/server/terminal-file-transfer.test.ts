import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileTransferState } from '@muxus/shared/ws-protocol';
import { StagedFiles } from '../../../server/src/file-transfer/staged-files.js';
import {
  printableTail,
  TerminalFileTransfers,
} from '../../../server/src/file-transfer/terminal-file-transfer.js';
import {
  CANCEL_SEQUENCE,
  TransferInput,
  type OutgoingFile,
  type TransferContext,
} from '../../../server/src/file-transfer/transfer-io.js';
import { xmodemReceive } from '../../../server/src/file-transfer/xymodem.js';
import { zmodemSend } from '../../../server/src/file-transfer/zmodem.js';

const FAST = { start: 2_000, startInterval: 200, reply: 500, byte: 200, retries: 10 };
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A terminal session whose remote end is one of our own protocol implementations. */
function session() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muxus-transfer-test-'));
  roots.push(root);
  const files = new StagedFiles(root);
  const displayed: Buffer[] = [];
  const frames: FileTransferState[] = [];
  const notes: string[] = [];
  const written: Buffer[] = [];
  const abort = new AbortController();
  const remoteInput = new TransferInput(abort.signal);
  const transfers: TerminalFileTransfers = new TerminalFileTransfers({
    link: {
      write: (data) => {
        const copy = Buffer.from(data);
        written.push(copy);
        setImmediate(() => remoteInput.push(copy));
      },
      drain: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    },
    display: (data) => displayed.push(Buffer.from(data)),
    send: (message) => {
      if (message.op === 'file-transfer') frames.push(message.transfer);
    },
    note: (message) => notes.push(message),
    files,
    timing: FAST,
    settleQuietMs: 50,
  });
  const remote: TransferContext = {
    input: remoteInput,
    output: {
      write: (data) => {
        const copy = Buffer.from(data);
        setImmediate(() => transfers.output(copy));
      },
      drain: async () => undefined,
    },
    signal: abort.signal,
    progress: () => undefined,
    timing: FAST,
  };
  const screen = () => Buffer.concat(displayed).toString('latin1');
  const phase = (wanted: FileTransferState['phase']) =>
    vi.waitFor(
      () => {
        const frame = frames.findLast((candidate) => candidate.phase === wanted);
        if (!frame) throw new Error(`no ${wanted} frame yet`);
        return frame;
      },
      { timeout: 5000, interval: 10 },
    );
  return { transfers, files, remote, displayed, frames, notes, written, screen, phase, abort };
}

function outgoing(name: string, data: Buffer): OutgoingFile {
  return { name, size: data.length, read: async (position, length) => data.subarray(position, position + length) };
}

describe('terminal file transfers', () => {
  it('passes ordinary output straight through', () => {
    const test = session();
    test.transfers.output(Buffer.from('hello **world**\r\n'));
    expect(test.screen()).toBe('hello **world**\r\n');
    expect(test.transfers.busy).toBe(false);
    expect(test.frames).toEqual([]);
  });

  it('offers a file the remote side sends with sz, receives it and resumes the terminal', async () => {
    const test = session();
    const payload = randomBytes(200_000);
    payload.write('PAYLOAD-MARKER', 1000, 'ascii');
    test.transfers.output(Buffer.from('$ sz report.bin\r\n'));
    const sending = zmodemSend(test.remote, [outgoing('report.bin', payload)], { announce: true });

    const offer = await test.phase('offer');
    expect(offer).toMatchObject({ direction: 'receive', protocol: 'zmodem', automatic: true, fileName: 'report.bin', total: 200_000 });
    expect(test.transfers.busy).toBe(true);
    test.transfers.control({ op: 'file-transfer-start', direction: 'receive', protocol: 'zmodem' });

    expect(await sending).toEqual({ sent: ['report.bin'], skipped: [] });
    // The shell prompts once sz has written its "OO" and exited.
    await new Promise((resolve) => setImmediate(resolve));
    test.transfers.output(Buffer.from('$ '));
    const done = await test.phase('complete');
    expect(done.received).toHaveLength(1);
    const staged = test.files.get(done.received[0]!.id)!;
    expect(digest(readFileSync(staged.path))).toBe(digest(payload));
    // sz typed "rz\r" in a chunk of its own, so it is erased rather than hidden.
    await vi.waitFor(() => expect(test.screen()).toBe('$ sz report.bin\r\nrz\r\x1b[2K$ '));
    expect(test.screen()).not.toContain('PAYLOAD-MARKER');
    expect(test.transfers.busy).toBe(false);
    expect(test.notes).toEqual(['ZMODEM: received report.bin (195 KiB)']);
  });

  it('declines an sz offer by skipping, so sz still ends cleanly', async () => {
    const test = session();
    const sending = zmodemSend(test.remote, [outgoing('a.bin', randomBytes(10)), outgoing('b.bin', randomBytes(10))], {
      announce: true,
    });
    await test.phase('offer');
    test.transfers.control({ op: 'file-transfer-cancel' });
    expect(await sending).toEqual({ sent: [], skipped: ['a.bin', 'b.bin'] });
    const done = await test.phase('cancelled');
    expect(done.message).toBe('Declined.');
    expect(Buffer.concat(test.written).includes(CANCEL_SEQUENCE)).toBe(false);
  });

  it('sends the CAN sequence on cancel, then shows what the remote printed', async () => {
    const test = session();
    test.transfers.control({ op: 'file-transfer-start', direction: 'receive', protocol: 'xmodem-crc', fileName: 'x.bin' });
    await vi.waitFor(() => expect(test.written.length).toBeGreaterThan(0));
    expect(test.frames[0]).toMatchObject({ direction: 'receive', protocol: 'xmodem-crc', phase: 'waiting' });
    expect(test.transfers.busy).toBe(true);
    test.transfers.control({ op: 'file-transfer-cancel' });
    await test.phase('cancelling');
    await vi.waitFor(() => expect(Buffer.concat(test.written).includes(CANCEL_SEQUENCE)).toBe(true));
    // Protocol noise still in flight is dropped; the remote's own text is kept.
    test.transfers.output(Buffer.from([0x01, 0x02, 0xfe, 0x18]));
    test.transfers.output(Buffer.from('\r\nAborted\r\n=> '));
    await test.phase('cancelled');
    expect(test.screen()).toBe('\r\n\r\nAborted\r\n=> ');
    expect(test.transfers.busy).toBe(false);
    expect(test.notes).toEqual(['XMODEM-CRC transfer cancelled']);
  });

  it('sends a staged upload with XMODEM and forgets it afterwards', async () => {
    const test = session();
    const data = randomBytes(5000);
    const staged = await test.files.upload('fw.bin', Readable.from([data]));
    const receiving = (async () => {
      const chunks: Buffer[] = [];
      await xmodemReceive(
        test.remote,
        { write: async (chunk) => void chunks.push(Buffer.from(chunk)), finish: async () => undefined, discard: async () => undefined },
        { crc: true },
      );
      return Buffer.concat(chunks);
    })();
    test.transfers.control({ op: 'file-transfer-start', direction: 'send', protocol: 'xmodem-1k', files: [staged.id] });
    const received = await receiving;
    expect(digest(received.subarray(0, data.length))).toBe(digest(data));
    const done = await test.phase('complete');
    expect(done).toMatchObject({ direction: 'send', fileName: 'fw.bin', fileCount: 1, bytes: 5000 });
    expect(test.files.get(staged.id)).toBeUndefined();
  });

  it('keeps only the trailing text after a cancelled transfer', () => {
    expect(printableTail(Buffer.from([0x99, 0x18, 0x41, 0x42, 0x0d, 0x0a, 0x24, 0x20])).toString('latin1')).toBe('AB\r\n$ ');
    expect(printableTail(Buffer.from([0x00, 0xff])).length).toBe(0);
    // Text still in flight from the file itself stays off the screen.
    const text = Buffer.from(`${'line of the file\n'.repeat(50)}\r\nAborted\r\n=> `);
    expect(printableTail(text).toString('latin1')).toBe('line of the file\n\r\nAborted\r\n=> ');
  });
});
