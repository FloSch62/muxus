import type { IDecorationOptions, IDisposable, Terminal } from '@xterm/xterm';

/** VS Code's terminalCommandDecoration.errorBackground — the red it uses
 *  for failed-command marks in the scrollbar. */
export const ERROR_MARK_COLOR = '#f14c4c';

/** The slice of IMarker the tracker needs (kept narrow for tests). */
export interface CommandMarker {
  readonly isDisposed: boolean;
  dispose(): void;
}

/** The slice of Terminal the tracker needs (kept narrow for tests). */
export interface MarkerHost {
  registerMarker(cursorYOffset?: number): CommandMarker | undefined;
  registerDecoration(options: {
    marker: CommandMarker;
    overviewRulerOptions: { color: string; position: 'left' };
  }): unknown;
}

const MAX_TERMINAL_CWD_LENGTH = 4096;
const CWD_PROPERTY_PREFIX = 'P;Cwd=';

/** Decode the escaping used by OSC 133/633 property values. */
function decodePropertyValue(value: string): string | undefined {
  let decoded = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char !== '\\') {
      decoded += char;
      continue;
    }
    const next = value[index + 1];
    if (next === '\\') {
      decoded += '\\';
      index++;
      continue;
    }
    const hex = value.slice(index + 2, index + 4);
    if (next !== 'x' || !/^[0-9a-f]{2}$/i.test(hex)) return undefined;
    decoded += String.fromCharCode(Number.parseInt(hex, 16));
    index += 3;
  }
  return decoded;
}

function validRemoteCwd(value: string | undefined): value is string {
  return !!value && value.startsWith('/') && value.length <= MAX_TERMINAL_CWD_LENGTH;
}

/** Reads current-directory reports from shell integration and standard OSC 7. */
export class CwdTracker {
  private current: string | undefined;

  constructor(private readonly onChange: (cwd: string) => void) {}

  handleProperty(data: string): boolean {
    if (!data.startsWith(CWD_PROPERTY_PREFIX)) return false;
    this.report(decodePropertyValue(data.slice(CWD_PROPERTY_PREFIX.length)));
    return true;
  }

  handleFileUri(data: string): boolean {
    try {
      const uri = new URL(data);
      if (uri.protocol !== 'file:') return false;
      this.report(decodeURIComponent(uri.pathname));
      return true;
    } catch {
      return false;
    }
  }

  private report(cwd: string | undefined): void {
    if (!validRemoteCwd(cwd) || cwd === this.current) return;
    this.current = cwd;
    this.onChange(cwd);
  }
}

/**
 * Turns shell-integration command reports into scrollbar marks. OSC 133
 * (FinalTerm) / OSC 633 (VS Code) sequences carry "command started"
 * (B / C) and "command finished with exit code" (D;n); a non-zero exit
 * paints the command's line red in the overview ruler, exactly like
 * VS Code's failed-command decorations. Local shells get the sequences
 * from the injected integration (server/src/local/shell-integration.ts);
 * zsh/bash SSH sessions get an equivalent remote-side integration.
 */
export class CommandTracker {
  private commandStart: CommandMarker | undefined;

  constructor(private readonly term: MarkerHost) {}

  /** Handle one OSC 133/633 payload; returns true when consumed. */
  handle(data: string): boolean {
    const separator = data.indexOf(';');
    const kind = separator === -1 ? data : data.slice(0, separator);
    const arg = separator === -1 ? undefined : data.slice(separator + 1);
    switch (kind) {
      case 'B': // command input starts (prompt end)
      case 'C': { // command executes
        this.commandStart?.dispose();
        this.commandStart = this.term.registerMarker(0);
        return true;
      }
      case 'D': { // command finished: D;<exit code>
        const marker = this.commandStart;
        this.commandStart = undefined;
        if (!marker || marker.isDisposed) return true;
        const exitCode = arg ? Number.parseInt(arg, 10) : Number.NaN;
        if (Number.isInteger(exitCode) && exitCode !== 0) {
          this.term.registerDecoration({
            marker,
            overviewRulerOptions: { color: ERROR_MARK_COLOR, position: 'left' },
          });
        } else {
          marker.dispose();
        }
        return true;
      }
      case 'A': { // prompt starts: any pending command never reported back
        this.commandStart?.dispose();
        this.commandStart = undefined;
        return true;
      }
      default:
        return false;
    }
  }

  dispose(): void {
    this.commandStart?.dispose();
    this.commandStart = undefined;
  }
}

/** Wire a tracker to a live terminal on both OSC channels. */
export function attachCommandTracker(term: Terminal): IDisposable {
  const tracker = new CommandTracker({
    registerMarker: (cursorYOffset) => term.registerMarker(cursorYOffset),
    registerDecoration: (options) => term.registerDecoration(options as IDecorationOptions),
  });
  const handler = (data: string) => tracker.handle(data);
  const osc133 = term.parser.registerOscHandler(133, handler);
  const osc633 = term.parser.registerOscHandler(633, handler);
  return {
    dispose: () => {
      osc133.dispose();
      osc633.dispose();
      tracker.dispose();
    },
  };
}

/** Track the working directory reported by integrated and OSC 7-aware shells. */
export function attachCwdTracker(term: Terminal, onChange: (cwd: string) => void): IDisposable {
  const tracker = new CwdTracker(onChange);
  const osc7 = term.parser.registerOscHandler(7, (data) => tracker.handleFileUri(data));
  const propertyHandler = (data: string) => tracker.handleProperty(data);
  const osc133 = term.parser.registerOscHandler(133, propertyHandler);
  const osc633 = term.parser.registerOscHandler(633, propertyHandler);
  return {
    dispose: () => {
      osc7.dispose();
      osc133.dispose();
      osc633.dispose();
    },
  };
}
