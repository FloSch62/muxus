import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ignoreClosedConsole } from '../../../electron/src/console-output.js';

describe('console output', () => {
  it('survives a write to a pipe nobody reads any more', async () => {
    // As when the program reading the app's output through a pipe exits:
    // the reading end closes while the app keeps writing to it.
    const reader = spawn(
      process.execPath,
      ['-e', "require('node:fs').closeSync(0); process.stdout.write('closed'); setTimeout(() => {}, 10_000)"],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    try {
      await once(reader.stdout!, 'data');
      const stdout = reader.stdin!;
      ignoreClosedConsole([stdout]);

      // Not events.once: it would take the stream's error event itself.
      const closed = new Promise((resolve) => stdout.on('close', resolve));
      stdout.write('{"msg":"request completed"}\n');

      await closed;
    } finally {
      reader.kill();
    }
  });

  it('ignores a terminal that went away too', () => {
    // What a write reports once the terminal the app was started from has closed.
    const stderr = new PassThrough();
    ignoreClosedConsole([stderr]);

    expect(() => stderr.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }))).not.toThrow();
  });
});
