export function requiresPasteConfirmation(text: string): boolean {
  return /[\r\n]/.test(text);
}

export function pasteLineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}
