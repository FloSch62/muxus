import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/** Where Muxus serves the containerlab topology viewer; the server sets its frame policy. */
export const CLAB_VIEWER_BASE = '/vendor/clab-viewer/';

/**
 * Muxus frames viewer.html directly: the <clab-topology> element, the bundler
 * entry, type declarations and the build's size report are not needed.
 */
const UNUSED = new Set(['component.mjs', 'component.css', 'index.js', 'startup-budget.json']);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** The published viewer build of @containerlab/clab-viewer. */
function viewerDist(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('@containerlab/clab-viewer/static/viewer.html'));
}

function shipped(dist: string, file: string): boolean {
  const name = relative(dist, file);
  return !name.endsWith('.d.ts') && !UNUSED.has(name);
}

/**
 * Serves the containerlab topology viewer from its npm package under
 * /vendor/clab-viewer/ in development and copies it into the build. The whole
 * dist/ directory is kept together: viewer.html loads its assets relative to
 * itself.
 */
export function clabViewer(): Plugin {
  const dist = viewerDist();
  let config: ResolvedConfig;
  return {
    name: 'muxus:clab-viewer',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      server.middlewares.use(CLAB_VIEWER_BASE, (req, res, next) => {
        const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
        const file = resolve(dist, `.${path === '/' ? '/viewer.html' : path}`);
        if (!file.startsWith(dist + sep) || !shipped(dist, file) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    writeBundle() {
      const output = join(resolve(config.root, config.build.outDir), CLAB_VIEWER_BASE);
      cpSync(dist, output, { recursive: true, filter: (source) => shipped(dist, source) });
      cpSync(join(dist, '..', 'LICENSE'), join(output, 'LICENSE'));
    },
  };
}
