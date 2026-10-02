import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type StoreResult = 'available' | 'up-to-date' | 'updated' | 'canceled';
export interface StoreBridge {
  run(command: 'check' | 'install', onProgress: (percent: number) => void): Promise<StoreResult>;
}

/** The executable inherits the Store package identity from the Electron process. */
export function createStoreBridge(executable: string, getWindowHandle: () => Buffer): StoreBridge {
  return {
    run(command, onProgress) {
      return new Promise((resolve, reject) => {
        const handle = getWindowHandle();
        const owner = handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
        const child = spawn(executable, [command, owner], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let result: StoreResult | undefined;
        let failure: Error | undefined;
        let diagnostics = '';
        // A check cannot hang forever. Installation may legitimately wait for
        // consent or a slow download, so it has no arbitrary timeout.
        const timeout = command === 'check' ? setTimeout(() => {
          failure = new Error('Microsoft Store update check timed out.');
          child.kill();
        }, 60_000) : undefined;
        timeout?.unref();
        child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          try {
            const message = JSON.parse(line) as { status?: string; percent?: number };
            if (message.status === 'installing' && command === 'install' && typeof message.percent === 'number' && Number.isFinite(message.percent)) {
              onProgress(Math.max(0, Math.min(100, Math.floor(message.percent))));
            } else if (['available', 'up-to-date', 'updated', 'canceled'].includes(message.status ?? '')) {
              if (command === 'check' && !['available', 'up-to-date'].includes(message.status!)) throw new Error('Unexpected Store check result.');
              result = message.status as StoreResult;
            } else {
              throw new Error('Microsoft Store helper reported an error.');
            }
          } catch (error) {
            failure = error instanceof Error ? error : new Error('Invalid Store helper response.');
          }
        });
        child.once('error', (error) => { clearTimeout(timeout); lines.close(); reject(error); });
        child.once('close', (code) => {
          clearTimeout(timeout);
          lines.close();
          if (failure || code !== 0 || !result) reject(new Error(`${failure?.message ?? `Store helper failed (${code}).`} ${diagnostics}`.trim()));
          else resolve(result);
        });
      });
    },
  };
}
