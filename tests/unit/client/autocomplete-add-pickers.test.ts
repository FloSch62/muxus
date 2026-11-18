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
 * The opening tag of each `<Autocomplete>` in `source`, without the `{…}`
 * nested inside its attribute values, so only its own attributes match.
 */
function autocompleteTags(source: string): { line: number; attributes: string }[] {
  return [...source.matchAll(/<Autocomplete\b(?:<[^>]*>)?/g)].map((match) => {
    let depth = 0;
    let attributes = '';
    for (const char of source.slice(match.index + match[0].length)) {
      if (depth === 0 && char === '>') break;
      if (char === '{') depth++;
      if (depth <= 1) attributes += char;
      if (char === '}') depth--;
    }
    return { line: source.slice(0, match.index).split('\n').length, attributes };
  });
}

/**
 * An Autocomplete that adds what is typed or picked to a list holds the text
 * in a `pending` state and clears it once the entry is added. If MUI keeps the
 * entry as the Autocomplete's own value, it writes the value's label back into
 * the input on the next render (an `onInputChange` with reason `reset`), so
 * the field refills. `value={null}` keeps the input empty.
 */
describe('Autocompletes that add to a list', () => {
  it('hold no value, so the input clears after adding', () => {
    const pickers = sourceFiles(CLIENT_SRC).flatMap((file) =>
      autocompleteTags(fs.readFileSync(file, 'utf8'))
        .filter(({ attributes }) => /\sinputValue=\{pending\w*\}/.test(attributes))
        .map(({ line, attributes }) => ({ at: `${path.relative(CLIENT_SRC, file)}:${line}`, attributes })),
    );
    const holdingValue = pickers.filter(({ attributes }) => !/\svalue=\{null\}/.test(attributes));
    expect(pickers.length).toBeGreaterThan(0);
    expect(holdingValue.map(({ at }) => at)).toEqual([]);
  });
});
