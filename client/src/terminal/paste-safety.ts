export function requiresPasteConfirmation(text: string): boolean {
  return /[\r\n]/.test(text);
}

export function pasteLineCount(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      count += 1;
    } else if (code === 13) {
      count += 1;
      if (text.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return count;
}

/** An invisible or look-alike character in a paste, and its ASCII stand-in. */
export interface FlaggedPasteCharacter {
  /** UTF-16 offset in the text. */
  index: number;
  /** 1-based; line breaks count as in `pasteLineCount`. */
  line: number;
  /** 1-based, in characters. */
  column: number;
  char: string;
  name: string;
  /** What "Replace with ASCII" puts in its place; empty removes it. */
  ascii: string;
}

const FLAGGED_CHARACTERS: Readonly<Record<string, { name: string; ascii: string }>> = {
  '\u00a0': { name: 'No-break space', ascii: ' ' },
  '\u202f': { name: 'Narrow no-break space', ascii: ' ' },
  '\u200b': { name: 'Zero-width space', ascii: '' },
  '\u200c': { name: 'Zero-width non-joiner', ascii: '' },
  '\u200d': { name: 'Zero-width joiner', ascii: '' },
  '\u2060': { name: 'Word joiner', ascii: '' },
  '\ufeff': { name: 'Zero-width no-break space', ascii: '' },
  '\u2018': { name: 'Left single quote', ascii: "'" },
  '\u2019': { name: 'Right single quote', ascii: "'" },
  '\u201a': { name: 'Low single quote', ascii: "'" },
  '\u201c': { name: 'Left double quote', ascii: '"' },
  '\u201d': { name: 'Right double quote', ascii: '"' },
  '\u201e': { name: 'Low double quote', ascii: '"' },
  '\u2013': { name: 'En dash', ascii: '-' },
  // Smart dashes turn a typed "--" into an em dash.
  '\u2014': { name: 'Em dash', ascii: '--' },
};

/** Cyrillic and Greek letters drawn like Latin ones. */
const LATIN_LOOKALIKES: Readonly<Record<string, string>> = {
  '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u0410': 'A', '\u0412': 'B',
  '\u0415': 'E', '\u041a': 'K', '\u041c': 'M', '\u041d': 'H', '\u041e': 'O',
  '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0423': 'Y', '\u0425': 'X',
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0456': 'i', '\u0458': 'j',
  '\u04bb': 'h', '\u04cf': 'l', '\u0501': 'd', '\u051b': 'q', '\u051d': 'w',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
  '\u0399': 'I', '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O',
  '\u03a1': 'P', '\u03a4': 'T', '\u03a5': 'Y', '\u03a7': 'X', '\u03b1': 'a',
  '\u03b9': 'i', '\u03bd': 'v', '\u03bf': 'o', '\u03c1': 'p',
};

const LETTER = /\p{L}/u;
const LATIN_LETTER = /[A-Za-z]/;

/** Replace removes zero-width characters, so they join the letters around them into one word. */
function inWord(char: string): boolean {
  return LETTER.test(char) || FLAGGED_CHARACTERS[char]?.ascii === '';
}

/** Look-alikes count only in a word with Latin letters, so Cyrillic and Greek text is left alone. */
function inLatinWord(text: string, index: number): boolean {
  for (let at = index - 1; at >= 0 && inWord(text.charAt(at)); at -= 1) {
    if (LATIN_LETTER.test(text.charAt(at))) return true;
  }
  for (let at = index + 1; at < text.length && inWord(text.charAt(at)); at += 1) {
    if (LATIN_LETTER.test(text.charAt(at))) return true;
  }
  return false;
}

export function flagPasteCharacters(text: string): FlaggedPasteCharacter[] {
  const flagged: FlaggedPasteCharacter[] = [];
  let line = 1;
  let column = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) {
      if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      line += 1;
      column = 0;
      continue;
    }
    // The second half of a surrogate pair is the same character.
    if (code >= 0xdc00 && code <= 0xdfff) {
      const previous = text.charCodeAt(index - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) continue;
    }
    column += 1;
    if (code < 0xa0) continue;
    const char = text.charAt(index);
    const known = FLAGGED_CHARACTERS[char];
    if (known) {
      flagged.push({ index, line, column, char, ...known });
      continue;
    }
    const latin = LATIN_LOOKALIKES[char];
    if (latin && inLatinWord(text, index)) {
      const name = code < 0x400 ? 'Greek letter' : 'Cyrillic letter';
      flagged.push({ index, line, column, char, name, ascii: latin });
    }
  }
  return flagged;
}

/** Puts each flagged character's ASCII stand-in in its place; nothing else changes. */
export function replaceFlaggedCharacters(
  text: string,
  flagged: readonly FlaggedPasteCharacter[],
): string {
  let result = '';
  let from = 0;
  for (const { index, char, ascii } of flagged) {
    result += text.slice(from, index) + ascii;
    from = index + char.length;
  }
  return result + text.slice(from);
}
