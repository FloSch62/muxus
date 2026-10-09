import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { nanoid } from 'nanoid';
import { baseName, type IncomingFile, type OutgoingFile } from './transfer-io.js';

/** Unclaimed files are removed after this long. */
const STAGED_FILE_TTL_MS = 60 * 60 * 1000;

export interface StagedFile {
  id: string;
  name: string;
  size: number;
  path: string;
  mtimeMs?: number;
  createdAt: number;
}

/**
 * Files on their way between the browser and a terminal transfer. Uploads
 * wait here until a send starts; received files wait until the browser
 * fetches them. They live in a private temporary directory under random
 * ids, so a name chosen by the remote side never becomes a local path.
 */
export class StagedFiles {
  private directory: Promise<string> | undefined;
  private readonly files = new Map<string, StagedFile>();

  constructor(private readonly root = os.tmpdir()) {}

  private dir(): Promise<string> {
    this.directory ??= mkdtemp(path.join(this.root, 'muxus-transfer-'));
    return this.directory;
  }

  async upload(name: string, body: NodeJS.ReadableStream, mtimeMs?: number): Promise<StagedFile> {
    await this.sweep();
    const id = nanoid(21);
    const file = path.join(await this.dir(), id);
    try {
      await pipeline(body, createWriteStream(file, { mode: 0o600 }));
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    }
    const { size } = await stat(file);
    const staged: StagedFile = {
      id,
      name: baseName(name) || 'file',
      size,
      path: file,
      ...(mtimeMs === undefined ? {} : { mtimeMs }),
      createdAt: Date.now(),
    };
    this.files.set(id, staged);
    return staged;
  }

  get(id: string): StagedFile | undefined {
    return this.files.get(id);
  }

  /** Forget a file and delete it. */
  async remove(id: string): Promise<void> {
    const staged = this.files.get(id);
    if (!staged) return;
    this.files.delete(id);
    await rm(staged.path, { force: true });
  }

  /** Readable view of a staged upload for a sending protocol. */
  async outgoing(id: string): Promise<{ file: OutgoingFile; close(): Promise<void> }> {
    const staged = this.files.get(id);
    if (!staged) throw new Error('The file to send is no longer available.');
    const handle = await open(staged.path, 'r');
    return {
      file: {
        name: staged.name,
        size: staged.size,
        ...(staged.mtimeMs === undefined ? {} : { mtimeMs: staged.mtimeMs }),
        read: async (position, length) => {
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          return buffer.subarray(0, bytesRead);
        },
      },
      close: () => handle.close(),
    };
  }

  /** A new file a receiving protocol writes into; it is listed once finished. */
  async incoming(name: string): Promise<{ file: IncomingFile; staged: Promise<StagedFile | undefined> }> {
    await this.sweep();
    const id = nanoid(21);
    const file = path.join(await this.dir(), id);
    const handle = await open(file, 'wx', 0o600);
    let written = 0;
    let settle!: (staged: StagedFile | undefined) => void;
    const staged = new Promise<StagedFile | undefined>((resolve) => {
      settle = resolve;
    });
    return {
      staged,
      file: {
        write: async (data) => {
          await handle.write(data, 0, data.length, written);
          written += data.length;
        },
        finish: async (size) => {
          await handle.close();
          if (size !== undefined && size < written) {
            await truncate(file, size);
            written = size;
          }
          const result: StagedFile = {
            id,
            name: baseName(name) || 'file',
            size: written,
            path: file,
            createdAt: Date.now(),
          };
          this.files.set(id, result);
          settle(result);
        },
        discard: async () => {
          await handle.close().catch(() => undefined);
          await rm(file, { force: true });
          settle(undefined);
        },
      },
    };
  }

  async sweep(now = Date.now()): Promise<void> {
    for (const [id, staged] of this.files) {
      if (now - staged.createdAt > STAGED_FILE_TTL_MS) await this.remove(id);
    }
  }

  async close(): Promise<void> {
    this.files.clear();
    const directory = this.directory;
    this.directory = undefined;
    if (directory) await rm(await directory, { recursive: true, force: true });
  }
}
