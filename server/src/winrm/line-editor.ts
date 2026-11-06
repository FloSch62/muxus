/**
 * Local line editing for a remote command that reads plain pipes (WinRS):
 * what a console's cooked mode would otherwise do. Typed text is echoed and
 * kept until Enter; Backspace, Ctrl+U and Ctrl+W edit it; Up and Down walk
 * the lines sent before; Ctrl+C interrupts the remote command.
 */
export class LineEditor {
  private line: string[] = [];
  /** Sent lines, each as the characters it was typed as. */
  private readonly history: string[][] = [];
  private historyIndex = 0;
  private escape: 'none' | 'esc' | 'csi' | 'ss3' = 'none';
  private csi = '';
  private lastWasCr = false;

  constructor(
    private readonly out: {
      echo(text: string): void;
      line(text: string): void;
      interrupt(): void;
    },
    private readonly historyLimit = 200,
  ) {}

  input(text: string): void {
    for (const char of text) this.char(char);
  }

  private char(char: string): void {
    if (this.escape === 'esc') {
      this.escape = char === '[' ? 'csi' : char === 'O' ? 'ss3' : 'none';
      this.csi = '';
      return;
    }
    if (this.escape === 'ss3') {
      this.escape = 'none';
      this.key(char);
      return;
    }
    if (this.escape === 'csi') {
      const code = char.codePointAt(0)!;
      if (code >= 0x40 && code <= 0x7e) {
        this.escape = 'none';
        // Bracketed-paste markers and other sequences with parameters are dropped.
        if (!this.csi) this.key(char);
      } else {
        this.csi += char;
      }
      return;
    }

    const wasCr = this.lastWasCr;
    this.lastWasCr = char === '\r';
    switch (char) {
      case '\x1b':
        this.escape = 'esc';
        return;
      case '\r':
        this.submit();
        return;
      case '\n':
        // CR LF from a paste is one Enter.
        if (!wasCr) this.submit();
        return;
      case '\x7f':
      case '\b':
        if (this.line.length > 0) {
          this.line.pop();
          this.out.echo('\b \b');
        }
        return;
      case '\x03':
        this.out.echo('^C\r\n');
        this.line = [];
        this.historyIndex = this.history.length;
        this.out.interrupt();
        return;
      case '\x15':
        this.replace([]);
        return;
      case '\x17': {
        const next = [...this.line];
        while (next.length > 0 && next.at(-1) === ' ') next.pop();
        while (next.length > 0 && next.at(-1) !== ' ') next.pop();
        this.replace(next);
        return;
      }
      case '\t':
        // No completion on the far side of a pipe.
        return;
      default:
        if ((char.codePointAt(0) ?? 0) < 0x20) return;
        this.line.push(char);
        this.out.echo(char);
    }
  }

  private key(final: string): void {
    if (final === 'A' && this.historyIndex > 0) {
      this.historyIndex -= 1;
      this.replace(this.history[this.historyIndex]!.slice());
    } else if (final === 'B' && this.historyIndex < this.history.length) {
      this.historyIndex += 1;
      this.replace(this.history[this.historyIndex]?.slice() ?? []);
    }
  }

  private replace(next: string[]): void {
    this.out.echo('\b \b'.repeat(this.line.length) + next.join(''));
    this.line = next;
  }

  private submit(): void {
    const text = this.line.join('');
    this.out.echo('\r\n');
    if (text.trim() && this.history.at(-1)?.join('') !== text) {
      this.history.push(this.line);
      if (this.history.length > this.historyLimit) this.history.shift();
    }
    this.historyIndex = this.history.length;
    this.line = [];
    this.out.line(text);
  }
}
