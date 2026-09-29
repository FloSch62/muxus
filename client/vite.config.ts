import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3002', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3002', ws: true },
    },
  },
  build: {
    target: 'esnext',
    manifest: true,
    // Monaco's full contribution layer is a deliberate, editor-only lazy
    // chunk; the stricter initial/feature budgets live in check-bundle-budget.
    chunkSizeWarningLimit: 2700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Earlier groups win; the react group keeps the first paint lean
          // and stops later groups from swallowing the runtime.
          groups: [
            { name: 'preload-helper', test: /vite[\\/]preload-helper/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            // addon-webgl stays out: it is lazy-loaded by the terminal so it
            // must land in its own async chunk, not the eager xterm chunk.
            { name: 'xterm', test: /node_modules[\\/]@xterm[\\/](?!addon-webgl)/ },
          ],
        },
      },
    },
  },
});
