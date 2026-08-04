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
