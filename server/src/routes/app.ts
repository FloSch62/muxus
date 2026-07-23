import os from 'node:os';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppInfo } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { defaultShell } from '../local/pty-manager.js';

function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    // Bundled main process (Electron): package.json is not on disk next to us.
    return process.env.MUXUS_VERSION ?? '0.0.0';
  }
}

export function registerAppRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.get('/api/app/info', (): AppInfo => {
    return {
      name: 'Muxus',
      version: serverVersion(),
      platform: process.platform,
      homeDir: os.homedir(),
      defaultShell: defaultShell(),
    };
  });
}
