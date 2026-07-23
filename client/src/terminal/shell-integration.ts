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
