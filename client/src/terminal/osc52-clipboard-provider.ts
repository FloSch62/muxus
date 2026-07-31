import type { IClipboardProvider } from '@xterm/addon-clipboard';

export type ClipboardWriter = (text: string) => void;

/**
 * OSC 52 provider that permits clipboard writes without exposing clipboard
 * contents to programs running in the terminal. Returning an empty string for
 * read requests gives callers a valid response without leaking local data.
 */
export class WriteOnlyClipboardProvider implements IClipboardProvider {
  constructor(
    private readonly writer: ClipboardWriter,
    private readonly allowWrite: () => boolean,
  ) {}

  readText(_selection: string): string {
    return '';
  }

  writeText(_selection: string, text: string): void {
    if (!this.allowWrite()) return;
    this.writer(text);
  }
}
