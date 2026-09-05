import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'istanbul',
      allowExternal: true,
      reporter: ['text-summary', 'json', 'html'],
    },
    server: { deps: { inline: ['zod'] } },
  },
  resolve: {
    // Tests exercise workspace sources directly — no build step required.
    alias: {
      '@muxus/shared/ws-protocol': path.resolve(here, '../shared/src/ws-protocol.ts'),
      '@muxus/shared': path.resolve(here, '../shared/src/index.ts'),
    },
  },
});
