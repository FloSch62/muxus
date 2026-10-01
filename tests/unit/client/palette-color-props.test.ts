import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLIENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../client/src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

/**
 * MUI 9 matches a component's `color` prop against palette keys only
 * (`textSecondary`, `warning`, …). A palette path such as `text.secondary` or
 * `warning.main` matches nothing and is dropped without a warning, so the text
 * silently renders in the primary ink. Paths belong in `sx`, where they resolve.
 */
describe('color props', () => {
  it('use palette keys, never palette paths', () => {
    const offenders = sourceFiles(CLIENT_SRC).flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          /\bcolor=(?:"[a-z]+\.[a-z]+"|\{[^}]*'[a-z]+\.[a-z]+'[^}]*\})/i.test(line)
            ? [`${path.relative(CLIENT_SRC, file)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});
