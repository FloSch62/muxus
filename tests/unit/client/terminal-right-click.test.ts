import { describe, expect, it } from 'vitest';
import {
  terminalRightClickIntent,
  xtermRightClickSelectsWord,
} from '../../../client/src/terminal/right-click.js';

describe('terminal right click', () => {
  it('preserves the macOS word-selection convention only for an empty context menu', () => {
    expect(xtermRightClickSelectsWord(true, 'menu', false)).toBe(true);
    expect(xtermRightClickSelectsWord(true, 'menu', true)).toBe(false);
    expect(xtermRightClickSelectsWord(true, 'copy-paste', false)).toBe(false);
    expect(xtermRightClickSelectsWord(true, 'paste', false)).toBe(false);
  });

  it('keeps xterm word selection disabled on Linux and Windows', () => {
    expect(xtermRightClickSelectsWord(false, 'menu', false)).toBe(false);
    expect(xtermRightClickSelectsWord(false, 'menu', true)).toBe(false);
    expect(xtermRightClickSelectsWord(false, 'copy-paste', false)).toBe(false);
    expect(xtermRightClickSelectsWord(false, 'paste', false)).toBe(false);
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
