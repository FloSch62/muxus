import { describe, expect, it } from 'vitest';
import { shouldFitTerminal } from '../../../client/src/terminal/terminal-fit.js';

describe('terminal fitting', () => {
  it('fits a container the browser has laid out', () => {
    expect(shouldFitTerminal({ clientWidth: 800, clientHeight: 400 })).toBe(true);
  });

  it('skips a pane hidden behind another tab', () => {
    // display:none leaves no box to measure, and the fit addon would fall back
    // to its two-column floor and SIGWINCH the remote shell to that width.
    expect(shouldFitTerminal({ clientWidth: 0, clientHeight: 0 })).toBe(false);
    expect(shouldFitTerminal({ clientWidth: 800, clientHeight: 0 })).toBe(false);
    expect(shouldFitTerminal({ clientWidth: 0, clientHeight: 400 })).toBe(false);
  });

  it('skips an unmounted terminal', () => {
    expect(shouldFitTerminal(null)).toBe(false);
    expect(shouldFitTerminal(undefined)).toBe(false);
  });
});
