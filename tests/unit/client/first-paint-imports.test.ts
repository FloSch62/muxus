import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY = path.join(ROOT, 'client/src/main.tsx');
const WORKSPACE_PACKAGES: Record<string, string> = {
  '@muxus/shared': 'shared/src/index.ts',
  '@muxus/shared/ws-protocol': 'shared/src/ws-protocol.ts',
};

/**
 * What a module loads as soon as it runs: static imports and re-exports, but
 * not `import type`, `export type` or `import()`, which the bundler leaves
 * out of the chunks `index.html` loads.
 */
function runtimeImports(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)]
    .filter(([, typeOnly]) => !typeOnly)
    .map(([, , specifier]) => specifier!);
}

/** A source file of this repository, or the name of a package. */
function resolve(from: string, specifier: string): string {
  const workspace = WORKSPACE_PACKAGES[specifier];
  if (workspace) return path.join(ROOT, workspace);
  if (!specifier.startsWith('.')) {
    const parts = specifier.split('/');
    return parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  }
  const file = path.resolve(path.dirname(from), specifier);
  if (!file.endsWith('.js')) return file;
  const base = file.slice(0, -'.js'.length);
  return [`${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(candidate)) ?? file;
}

/** Every module the window loads before its first paint, with the chain that reached it. */
function firstPaintModules(): Map<string, string[]> {
  const chains = new Map<string, string[]>([[ENTRY, [path.relative(ROOT, ENTRY)]]]);
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of runtimeImports(fs.readFileSync(file, 'utf8'))) {
      const target = resolve(file, specifier);
      if (chains.has(target)) continue;
      chains.set(target, [...chains.get(file)!, path.isAbsolute(target) ? path.relative(ROOT, target) : target]);
      if (/\.tsx?$/.test(target)) queue.push(target);
    }
  }
  return chains;
}

describe('the first-paint bundle', () => {
  it('reaches no zod: the window needs the protocol constants, not its schemas', () => {
    const modules = firstPaintModules();
    expect(modules.has(path.join(ROOT, 'client/src/api/http.ts'))).toBe(true);
    expect(modules.has(path.join(ROOT, 'shared/src/index.ts'))).toBe(true);
    expect(modules.get('zod')).toBeUndefined();
  });
});
