import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The connection stack against a real OpenSSH server in a container:
 * `pnpm test:openssh`. It needs Docker, so it is not part of `pnpm test`.
 */
export default defineConfig({
  test: {
    include: ['openssh/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['openssh/container.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One server, and tests that pause it or count its sessions.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@muxus/shared/ws-protocol': path.resolve(here, '../shared/src/ws-protocol.ts'),
      '@muxus/shared': path.resolve(here, '../shared/src/index.ts'),
    },
  },
});
