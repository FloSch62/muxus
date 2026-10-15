import { describe, expect, it } from 'vitest';
import {
  flagPasteCharacters,
  pasteLineCount,
  replaceFlaggedCharacters,
  requiresPasteConfirmation,
} from '../../../client/src/terminal/paste-safety.js';

describe('terminal paste safety', () => {
  it('allows a single line without interruption', () => {
    expect(requiresPasteConfirmation('echo hello')).toBe(false);
    expect(pasteLineCount('echo hello')).toBe(1);
  });

  it('requires confirmation for LF, CRLF, CR, and a trailing newline', () => {
    for (const text of ['one\ntwo', 'one\r\ntwo', 'one\rtwo', 'rm -rf ./target\n']) {
      expect(requiresPasteConfirmation(text)).toBe(true);
      expect(pasteLineCount(text)).toBe(2);
    }
  });

  it('counts a very large paste without allocating a line array', () => {
    expect(pasteLineCount('line\n'.repeat(100_000))).toBe(100_001);
  });
});

describe('flagging invisible and look-alike characters', () => {
  it('leaves plain ASCII and accented Latin text alone', () => {
    expect(flagPasteCharacters('interface Gi0/1\n description caf\u00e9 "uplink"')).toEqual([]);
  });

  it('flags spaces, zero-width characters, quotes and dashes with their positions', () => {
    const text = 'echo\u00a0\u201chi\u201d\u200b\nls \u2013l \u2014all\r\n\ufeffx\u2019s';
    expect(
      flagPasteCharacters(text).map(({ index, line, column, name, ascii }) => [
        index, line, column, name, ascii,
      ]),
    ).toEqual([
      [4, 1, 5, 'No-break space', ' '],
      [5, 1, 6, 'Left double quote', '"'],
      [8, 1, 9, 'Right double quote', '"'],
      [9, 1, 10, 'Zero-width space', ''],
      [14, 2, 4, 'En dash', '-'],
      [17, 2, 7, 'Em dash', '--'],
      [23, 3, 1, 'Zero-width no-break space', ''],
      [25, 3, 3, 'Right single quote', "'"],
    ]);
  });

  it('counts columns in characters, not UTF-16 units', () => {
    expect(flagPasteCharacters('\u{1f600}\u00a0')[0]).toMatchObject({ index: 2, column: 2 });
  });

  it('flags Cyrillic and Greek look-alikes only in words with Latin letters', () => {
    // Look-alikes at the start, middle and end of a word with Latin letters are flagged;
    // the all-Cyrillic and all-Greek words stay.
    const text = 'hostname \u0441ore-sw1 G\u03bfg0 cor\u0435 \u0441\u043e\u0440 \u03b1\u03b2';
    expect(flagPasteCharacters(text).map(({ index, name, ascii }) => [index, name, ascii])).toEqual([
      [9, 'Cyrillic letter', 'c'],
      [19, 'Greek letter', 'o'],
      [26, 'Cyrillic letter', 'e'],
    ]);
  });

  it('cleans look-alikes joined to a Latin word by a zero-width character in one replacement', () => {
    const text = 'ping \u0441\u043e\u0440\u200be-01 sw\u2060\u0441\u043e';
    const replaced = replaceFlaggedCharacters(text, flagPasteCharacters(text));
    expect(replaced).toBe('ping cope-01 swco');
    expect(flagPasteCharacters(replaced)).toEqual([]);
  });

  it('joins words only across the characters that Replace removes', () => {
    // The NBSP and the quotes end a word, and a zero-width character alone does not make it Latin.
    const text = '\u0441\u043e\u0440\u200b \u0441\u00a0Cisco \u201c\u0441\u043e\u0440\u201dcore';
    expect(flagPasteCharacters(text).map(({ index }) => index)).toEqual([3, 6, 13, 17]);
  });

  it('replaces only the flagged characters', () => {
    const text = 'ping\u00a0\u0441ore \u0441\u043e\u0440 \u201cx\u201d\u200b \u2014 y';
    expect(replaceFlaggedCharacters(text, flagPasteCharacters(text))).toBe(
      'ping core \u0441\u043e\u0440 "x" -- y',
    );
    expect(replaceFlaggedCharacters('plain', [])).toBe('plain');
  });
});
