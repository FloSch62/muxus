import type { SessionLineTimestamp } from '@muxus/shared';

/**
 * Small streaming terminal-line reconciler used only for search and readable
 * transcripts. It applies the cursor/erase operations used by shells and
 * progress displays, retaining a few editable rows so prompt redraws replace
 * their earlier state instead of becoming duplicate transcript lines. The
 * original byte events remain untouched for exact export.
 */
export class TerminalTextNormalizer {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private state:
    | 'text'
    | 'escape'
    | 'escape-intermediate'
    | 'csi'
    | 'string'
    | 'string-escape' = 'text';
  private csi = '';
  private rows: string[][] = [[]];
  private cursorRow = 0;
  private cursorCol = 0;
  private savedCursor: [number, number] = [0, 0];
  private committed = '';
  private rowTimes: (string | undefined)[] = [];
  private currentTime = '';
  private committedTimes: SessionLineTimestamp[] = [];
  private emittedTimes: SessionLineTimestamp[] = [];

  takeLineTimestamps(): SessionLineTimestamp[] {
    const timestamps = this.emittedTimes;
    this.emittedTimes = [];
    return timestamps;
  }

  constructor(private readonly editableRows = 4) {}

  write(data: Uint8Array, recordedAt = new Date().toISOString()): string {
    this.currentTime = recordedAt;
    this.process(this.decoder.decode(data, { stream: true }));
    this.commitReadyRows();
    return this.takeCommitted();
  }

  /** Flush the currently visible rows and start a fresh transcript screen. */
  drain(): string {
    this.commitAllRows();
    this.resetRows();
    return this.takeCommitted();
  }

  /** Final decoder flush plus all still-editable rows at session end. */
  finish(): string {
    this.process(this.decoder.decode());
    return this.drain();
  }

  private process(decoded: string): void {
    for (const char of decoded) {
      const code = char.codePointAt(0)!;
      if (this.state === 'text') {
        if (code === 0x1b) {
          this.state = 'escape';
          continue;
        }
        if (char === '\r') {
          this.cursorCol = 0;
          continue;
        }
        if (char === '\n') {
          this.rowTimes[this.cursorRow] ??= this.currentTime;
          this.cursorRow += 1;
          this.ensureRow(this.cursorRow);
          continue;
        }
        if (char === '\b') {
          this.cursorCol = Math.max(0, this.cursorCol - 1);
          continue;
        }
        if (char === '\t') {
          const spaces = 8 - (this.cursorCol % 8);
          for (let index = 0; index < spaces; index += 1) this.put(' ');
          continue;
        }
        if (code >= 0x20 && code !== 0x7f) this.put(char);
        continue;
      }

      if (this.state === 'escape') {
        if (char === '[') {
          this.csi = '';
          this.state = 'csi';
        }
        else if (char === ']' || char === 'P' || char === '_' || char === '^') {
          this.state = 'string';
        } else if (code >= 0x20 && code <= 0x2f) {
          this.state = 'escape-intermediate';
        } else {
          this.handleEscape(char);
          this.state = 'text';
        }
        continue;
      }
      if (this.state === 'escape-intermediate') {
        if (code >= 0x30 && code <= 0x7e) this.state = 'text';
        continue;
      }
      if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          this.handleCsi(char);
          this.csi = '';
          this.state = 'text';
        } else {
          this.csi += char;
        }
        continue;
      }
      if (this.state === 'string') {
        if (code === 0x07) this.state = 'text';
        else if (code === 0x1b) this.state = 'string-escape';
        continue;
      }
      if (this.state === 'string-escape') {
        this.state = char === '\\' ? 'text' : char === '\x1b' ? 'string-escape' : 'string';
      }
    }
  }

  private put(char: string): void {
    const row = this.ensureRow(this.cursorRow);
    while (row.length < this.cursorCol) row.push(' ');
    row[this.cursorCol] = char;
    this.rowTimes[this.cursorRow] = this.currentTime;
    this.cursorCol += 1;
  }

  private handleEscape(final: string): void {
    if (final === '7') {
      this.savedCursor = [this.cursorRow, this.cursorCol];
      return;
    }
    if (final === '8') {
      [this.cursorRow, this.cursorCol] = this.savedCursor;
      this.ensureRow(this.cursorRow);
      return;
    }
    if (final === 'D') {
      this.cursorRow += 1;
      this.ensureRow(this.cursorRow);
      return;
    }
    if (final === 'E') {
      this.cursorRow += 1;
      this.cursorCol = 0;
      this.ensureRow(this.cursorRow);
      return;
    }
    if (final === 'M') {
      this.cursorRow = Math.max(0, this.cursorRow - 1);
      this.ensureRow(this.cursorRow);
      return;
    }
    if (final === 'c') this.resetRows();
  }

  private handleCsi(final: string): void {
    const privateMode = /^[?>]/.test(this.csi);
    const raw = this.csi.replace(/^[?>]/, '');
    const params = raw
      .split(';')
      .map((value) => (value === '' ? 0 : Number.parseInt(value, 10)))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const first = params[0] ?? 0;
    const amount = Math.max(1, first);

    if (privateMode && (final === 'h' || final === 'l')) return;
    switch (final) {
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - amount);
        break;
      case 'B':
        this.cursorRow += amount;
        break;
      case 'C':
        this.cursorCol += amount;
        break;
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - amount);
        break;
      case 'E':
        this.cursorRow += amount;
        this.cursorCol = 0;
        break;
      case 'F':
        this.cursorRow = Math.max(0, this.cursorRow - amount);
        this.cursorCol = 0;
        break;
      case 'G':
      case '`':
        this.cursorCol = Math.max(0, amount - 1);
        break;
      case 'H':
      case 'f':
        this.cursorRow = Math.max(0, (params[0] || 1) - 1);
        this.cursorCol = Math.max(0, (params[1] || 1) - 1);
        break;
      case 'd':
        this.cursorRow = Math.max(0, amount - 1);
        break;
      case 'J':
        this.eraseDisplay(first);
        break;
      case 'K':
        this.eraseLine(first);
        break;
      case 'P':
        this.rowTimes[this.cursorRow] = this.currentTime;
        this.ensureRow(this.cursorRow).splice(this.cursorCol, amount);
        break;
      case '@':
        this.rowTimes[this.cursorRow] = this.currentTime;
        this.ensureRow(this.cursorRow).splice(
          this.cursorCol,
          0,
          ...Array.from({ length: amount }, () => ' '),
        );
        break;
      case 'X': {
        this.rowTimes[this.cursorRow] = this.currentTime;
        const row = this.ensureRow(this.cursorRow);
        for (let index = 0; index < amount; index += 1) {
          if (this.cursorCol + index < row.length) row[this.cursorCol + index] = ' ';
        }
        break;
      }
      case 's':
        this.savedCursor = [this.cursorRow, this.cursorCol];
        break;
      case 'u':
        [this.cursorRow, this.cursorCol] = this.savedCursor;
        break;
    }
    this.ensureRow(this.cursorRow);
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      // A deliberate clear still belongs to searchable history, while the
      // following screen starts without stale editable prompt fragments.
      this.commitAllRows();
      this.resetRows();
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      this.rows.splice(this.cursorRow + 1);
      this.rowTimes.splice(this.cursorRow + 1);
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.cursorRow; row += 1) {
        this.rows[row] = [];
        this.rowTimes[row] = this.currentTime;
      }
      this.eraseLine(1);
    }
  }

  private eraseLine(mode: number): void {
    const row = this.ensureRow(this.cursorRow);
    this.rowTimes[this.cursorRow] = this.currentTime;
    if (mode === 2) {
      this.rows[this.cursorRow] = [];
      return;
    }
    if (mode === 1) {
      const end = Math.min(this.cursorCol, row.length - 1);
      for (let index = 0; index <= end; index += 1) row[index] = ' ';
      return;
    }
    row.splice(this.cursorCol);
  }

  private ensureRow(index: number): string[] {
    while (this.rows.length <= index) this.rows.push([]);
    return this.rows[index]!;
  }

  private commitReadyRows(): void {
    const count = Math.max(0, this.cursorRow - this.editableRows);
    for (let index = 0; index < count; index += 1) {
      this.recordLineTime(index);
      this.committed += `${lineText(this.rows[index]!)}\n`;
    }
    if (count === 0) return;
    this.rows.splice(0, count);
    this.rowTimes.splice(0, count);
    this.cursorRow -= count;
    this.savedCursor = [
      Math.max(0, this.savedCursor[0] - count),
      this.savedCursor[1],
    ];
  }

  private commitAllRows(): void {
    let last = this.rows.length - 1;
    while (last >= 0 && lineText(this.rows[last]!) === '') last -= 1;
    if (last < 0) return;
    for (let index = 0; index <= last; index += 1) {
      this.recordLineTime(index);
      this.committed += lineText(this.rows[index]!);
      if (index < last || last < this.rows.length - 1) this.committed += '\n';
    }
  }

  private recordLineTime(index: number): void {
    this.committedTimes.push({
      offset: this.committed.length,
      recordedAt: this.rowTimes[index] ?? this.currentTime,
    });
  }

  private resetRows(): void {
    this.rowTimes = [];
    this.rows = [[]];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.savedCursor = [0, 0];
  }

  private takeCommitted(): string {
    const output = this.committed;
    this.committed = '';
    this.emittedTimes = this.committedTimes;
    this.committedTimes = [];
    return output;
  }
}

function lineText(row: readonly string[]): string {
  let end = row.length;
  while (end > 0 && row[end - 1] === ' ') end -= 1;
  return row.slice(0, end).join('');
}
