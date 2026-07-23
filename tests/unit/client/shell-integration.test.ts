import { describe, expect, it } from 'vitest';
import {
  CommandTracker,
  ERROR_MARK_COLOR,
  type CommandMarker,
  type MarkerHost,
} from '../../../client/src/terminal/shell-integration.js';

class StubMarker implements CommandMarker {
  isDisposed = false;
  dispose(): void {
    this.isDisposed = true;
  }
}

class StubTerm implements MarkerHost {
  markers: StubMarker[] = [];
  decorations: Array<{ marker: CommandMarker; overviewRulerOptions: { color: string; position: 'left' } }> = [];

  registerMarker(): CommandMarker {
    const marker = new StubMarker();
    this.markers.push(marker);
    return marker;
  }

  registerDecoration(options: {
    marker: CommandMarker;
    overviewRulerOptions: { color: string; position: 'left' };
  }): unknown {
    this.decorations.push(options);
    return {};
  }
}

function run(sequences: string[]): StubTerm {
  const term = new StubTerm();
  const tracker = new CommandTracker(term);
  for (const seq of sequences) tracker.handle(seq);
  return term;
}

describe('CommandTracker', () => {
  it('marks a failed command in the overview ruler', () => {
    const term = run(['A', 'C', 'D;1', 'A']);
    expect(term.decorations).toHaveLength(1);
    expect(term.decorations[0]!.overviewRulerOptions).toEqual({ color: ERROR_MARK_COLOR, position: 'left' });
    expect(term.decorations[0]!.marker.isDisposed).toBe(false);
  });

  it('leaves successful commands unmarked and frees their marker', () => {
    const term = run(['A', 'C', 'D;0', 'A']);
    expect(term.decorations).toHaveLength(0);
    expect(term.markers[0]!.isDisposed).toBe(true);
  });

  it('accepts B (prompt end) as the command anchor', () => {
    const term = run(['A', 'B', 'D;127']);
    expect(term.decorations).toHaveLength(1);
  });

  it('ignores exit reports with no preceding command', () => {
    // Shells re-run precmd on an empty Enter and re-report the stale $?.
    const term = run(['A', 'D;1', 'A', 'D;1']);
    expect(term.decorations).toHaveLength(0);
  });

  it('ignores unparsable exit codes', () => {
    const term = run(['C', 'D;abc', 'C', 'D']);
    expect(term.decorations).toHaveLength(0);
  });

  it('drops a pending command when a new prompt starts first', () => {
    const term = run(['C', 'A', 'D;1']);
    expect(term.decorations).toHaveLength(0);
    expect(term.markers[0]!.isDisposed).toBe(true);
  });

  it('marks each failure across repeated cycles', () => {
    const term = run(['C', 'D;1', 'A', 'C', 'D;0', 'A', 'C', 'D;2', 'A']);
    expect(term.decorations).toHaveLength(2);
  });

  it('only consumes command-lifecycle kinds', () => {
    const term = new StubTerm();
    const tracker = new CommandTracker(term);
    expect(tracker.handle('C')).toBe(true);
    expect(tracker.handle('D;0')).toBe(true);
    expect(tracker.handle('P;Cwd=/tmp')).toBe(false);
    expect(tracker.handle('E;ls')).toBe(false);
  });
});
