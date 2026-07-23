import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERM, resolveTermEnv } from '../../../server/src/local/term-env.js';

/** Build a terminfo tree containing the given entries. */
function terminfoDir(entries: string[], layout: 'letter' | 'hex' = 'letter'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-terminfo-'));
  for (const term of entries) {
    const letter = term[0]!;
    const sub = layout === 'letter' ? letter : letter.charCodeAt(0).toString(16);
    mkdirSync(path.join(dir, sub), { recursive: true });
    writeFileSync(path.join(dir, sub, term), '');
  }
  return dir;
}

describe('resolveTermEnv', () => {
  it('keeps the requested term when the system database has it', () => {
    const system = terminfoDir(['xterm-kitty']);
    expect(resolveTermEnv('xterm-kitty', { system: [system], extra: [] })).toEqual({
      term: 'xterm-kitty',
    });
  });

  it('finds entries in the macOS hex directory layout', () => {
    const system = terminfoDir(['xterm-kitty'], 'hex');
    expect(resolveTermEnv('xterm-kitty', { system: [system], extra: [] })).toEqual({
      term: 'xterm-kitty',
    });
  });

  it('points TERMINFO at an out-of-database entry (kitty install)', () => {
    const empty = terminfoDir([]);
    const kitty = terminfoDir(['xterm-kitty']);
    expect(resolveTermEnv('xterm-kitty', { system: [empty], extra: [kitty] })).toEqual({
      term: 'xterm-kitty',
      terminfo: kitty,
    });
  });

  it('falls back to the default when the term is unknown everywhere', () => {
    const empty = terminfoDir([]);
    expect(resolveTermEnv('muxus-no-such-term', { system: [empty], extra: [] })).toEqual({
      term: DEFAULT_TERM,
    });
  });

  it('treats blank or missing requests as the default term', () => {
    const system = terminfoDir([DEFAULT_TERM]);
    expect(resolveTermEnv(undefined, { system: [system], extra: [] })).toEqual({ term: DEFAULT_TERM });
    expect(resolveTermEnv('   ', { system: [system], extra: [] })).toEqual({ term: DEFAULT_TERM });
  });
});
