import { describe, expect, it } from 'vitest';
import { decodeImportedText } from '@muxus/shared';
import { parseMobaXtermSessions } from '../../../client/src/mobaxterm-import.js';

describe('decodeImportedText', () => {
  it('reads UTF-8 text unchanged', () => {
    const bytes = new TextEncoder().encode('Sessions » Lab Antwerp é ü °');
    expect(decodeImportedText(bytes)).toBe('Sessions » Lab Antwerp é ü °');
  });

  it('drops a UTF-8 byte order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('[Bookmarks]')]);
    expect(decodeImportedText(bytes)).toBe('[Bookmarks]');
  });

  it('falls back to Windows-1252 for ANSI files', () => {
    // "Sessions » PoCs é €" as written by MobaXterm in the Windows ANSI code page.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('Sessions '),
      0xbb,
      ...new TextEncoder().encode(' PoCs '),
      0xe9,
      0x20,
      0x80,
    ]);
    expect(decodeImportedText(bytes)).toBe('Sessions » PoCs é €');
  });

  it('keeps MobaXterm folder names intact through parsing', () => {
    const ini = '[Bookmarks_1]\r\nSubRep=Sessions \xbb Lab Antwerp D0\r\nlab=#109#0%lab.example.com%22%root%%rest\r\n';
    const bytes = Uint8Array.from(ini, (char) => char.charCodeAt(0));
    const parsed = parseMobaXtermSessions(decodeImportedText(bytes));
    expect(parsed.sessions[0]?.folder).toBe('Sessions » Lab Antwerp D0');
  });
});
