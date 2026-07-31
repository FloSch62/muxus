import {
  Base64,
  ClipboardAddon,
} from '@xterm/addon-clipboard';
import type { Terminal } from '@xterm/xterm';
import {
  WriteOnlyClipboardProvider,
  type ClipboardWriter,
} from './osc52-clipboard-provider.js';

/** Attach OSC 52 clipboard handling; the terminal owns the addon's lifecycle. */
export function attachOsc52Clipboard(
  term: Terminal,
  writer: ClipboardWriter,
  allowWrite: () => boolean,
): void {
  term.loadAddon(
    new ClipboardAddon(
      new Base64(),
      new WriteOnlyClipboardProvider(writer, allowWrite),
    ),
  );
}
