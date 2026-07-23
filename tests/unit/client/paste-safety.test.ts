import { describe, expect, it } from 'vitest';
import {
  pasteLineCount,
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
});
