import { describe, expect, it } from 'vitest';
import {
  terminalRightClickIntent,
  XTERM_RIGHT_CLICK_OPTIONS,
} from '../../../client/src/terminal/right-click.js';

describe('terminal right click', () => {
  it('disables xterm macOS word selection so an existing selection is preserved', () => {
    expect(XTERM_RIGHT_CLICK_OPTIONS.rightClickSelectsWord).toBe(false);
  });

  it('copies the same existing selection regardless of the click position', () => {
    const selection = 'the original\nselection';

    expect(terminalRightClickIntent('copy-paste', selection)).toEqual({
      kind: 'copy',
      selection,
    });
  });

  it('pastes when copy-paste mode starts without a selection', () => {
    expect(terminalRightClickIntent('copy-paste', '')).toEqual({ kind: 'paste' });
  });

  it('always pastes in paste mode even when text is selected', () => {
    expect(terminalRightClickIntent('paste', 'leave this selected')).toEqual({ kind: 'paste' });
  });

  it('snapshots the selection for context-menu Copy', () => {
    expect(terminalRightClickIntent('menu', 'selected when opened')).toEqual({
      kind: 'menu',
      selection: 'selected when opened',
    });
    expect(terminalRightClickIntent('menu', '')).toEqual({ kind: 'menu', selection: '' });
  });
});
