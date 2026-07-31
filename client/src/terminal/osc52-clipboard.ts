import {
  Base64,
  ClipboardAddon,
} from '@xterm/addon-clipboard';
import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';
import {
  WriteOnlyClipboardProvider,
  type ClipboardWriter,
} from './osc52-clipboard-provider.js';

export type TerminalReplyWriter = (data: string) => void;

/**
 * Keep OSC 52 read replies on the source transport. ClipboardAddon sends its
 * replies through Terminal.input(), whose public onData event cannot preserve
 * xterm's user-vs-protocol origin flag and would look like multi-exec input.
 */
class WriteOnlyOsc52Addon implements ITerminalAddon {
  private readonly clipboard: ClipboardAddon;
  private queryHandler?: IDisposable;

  constructor(
    writer: ClipboardWriter,
    allowWrite: () => boolean,
    private readonly reply: TerminalReplyWriter,
  ) {
    this.clipboard = new ClipboardAddon(
      new Base64(),
      new WriteOnlyClipboardProvider(writer, allowWrite),
    );
  }

  activate(term: Terminal): void {
    this.clipboard.activate(term);
    // xterm calls the most recently registered OSC handler first. Consume
    // queries here; return false for writes so ClipboardAddon decodes them.
    this.queryHandler = term.parser.registerOscHandler(52, (data) => {
      const separator = data.indexOf(';');
      if (separator === -1 || data.slice(separator + 1) !== '?') return false;
      this.reply(`\x1b]52;${data.slice(0, separator)};\x07`);
      return true;
    });
  }

  dispose(): void {
    this.queryHandler?.dispose();
    this.clipboard.dispose();
  }
}

/** Attach OSC 52 clipboard handling; the terminal owns the addon's lifecycle. */
export function attachOsc52Clipboard(
  term: Terminal,
  writer: ClipboardWriter,
  allowWrite: () => boolean,
  reply: TerminalReplyWriter,
): void {
  term.loadAddon(new WriteOnlyOsc52Addon(writer, allowWrite, reply));
}
