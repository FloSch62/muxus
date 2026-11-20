/**
 * Decode an imported text file whose encoding is not declared.
 *
 * Windows tools such as MobaXterm save their INI files in the ANSI code page,
 * so a name like "Sessions » Lab" arrives as the lone byte 0xBB. Reading that
 * as UTF-8 turns it into U+FFFD. Strict UTF-8 is tried first (it also covers
 * plain ASCII), and Windows-1252 is the fallback when the bytes are not valid
 * UTF-8. A leading UTF-8 byte order mark is dropped either way.
 */
export function decodeImportedText(bytes: ArrayBuffer | ArrayBufferView): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
