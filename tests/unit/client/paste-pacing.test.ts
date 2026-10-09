import { describe, expect, it } from 'vitest';
import {
  formatPasteDuration,
  hostPastePacing,
  parsePasteDelay,
} from '../../../client/src/terminal/paste-pacing.js';

const settings = { pasteLineDelayMs: 150, pasteCharDelayMs: 2 };

describe('paste pacing for a session', () => {
  it('follows the Terminal settings where the host sets nothing', () => {
    expect(hostPastePacing(settings, undefined)).toEqual({ lineDelayMs: 150, charDelayMs: 2 });
    expect(hostPastePacing(settings, {})).toEqual({ lineDelayMs: 150, charDelayMs: 2 });
  });

  it('takes each delay a host sets, including 0 to turn pacing off', () => {
    expect(hostPastePacing(settings, { pasteLineDelayMs: 500 })).toEqual({
      lineDelayMs: 500,
      charDelayMs: 2,
    });
    expect(hostPastePacing(settings, { pasteLineDelayMs: 0, pasteCharDelayMs: 0 })).toEqual({
      lineDelayMs: 0,
      charDelayMs: 0,
    });
  });

  it('rounds the running time for reading', () => {
    expect(formatPasteDuration(400)).toBe('under a second');
    expect(formatPasteDuration(12_400)).toBe('about 12 s');
    expect(formatPasteDuration(240_000)).toBe('about 4 min');
  });

  it('reads a typed delay as empty, or a whole number clamped to range', () => {
    expect(parsePasteDelay('', 'line')).toBeUndefined();
    expect(parsePasteDelay('  ', 'char')).toBeUndefined();
    expect(parsePasteDelay('250', 'line')).toBe(250);
    expect(parsePasteDelay('12.6', 'char')).toBe(13);
    expect(parsePasteDelay('-5', 'line')).toBe(0);
    expect(parsePasteDelay('99999', 'line')).toBe(10_000);
    expect(parsePasteDelay('5000', 'char')).toBe(1_000);
  });
});
