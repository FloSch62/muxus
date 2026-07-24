import { describe, expect, it } from 'vitest';
import {
  MONO_FONT_FALLBACK,
  migratePrefsState,
  terminalFontStack,
} from '../../../client/src/state/prefs.js';

describe('terminalFontStack', () => {
  it('always includes the bundled Nerd Font symbol fallback', () => {
    expect(MONO_FONT_FALLBACK).toContain('"Pure Nerd Font"');
    expect(terminalFontStack('Iosevka')).toBe(`Iosevka, ${MONO_FONT_FALLBACK}`);
  });

  it('does not duplicate the bundled default font', () => {
    expect(terminalFontStack('JetBrains Mono')).toBe(MONO_FONT_FALLBACK);
    expect(terminalFontStack('"JetBrains Mono"')).toBe(MONO_FONT_FALLBACK);
    expect(terminalFontStack('monospace')).toBe(MONO_FONT_FALLBACK);
    expect(terminalFontStack('  ')).toBe(MONO_FONT_FALLBACK);
  });

  it('quotes custom family names containing spaces', () => {
    expect(terminalFontStack('Cascadia Code')).toBe(`"Cascadia Code", ${MONO_FONT_FALLBACK}`);
  });
});

describe('migratePrefsState', () => {
  it('removes the retired TERM preference without mutating the snapshot', () => {
    const persisted = { termName: 'xterm-kitty', monoFontSize: 16 };

    expect(migratePrefsState(persisted, 1)).toEqual({
      monoFontSize: 16,
    });
    expect(persisted.termName).toBe('xterm-kitty');
  });

  it('removes every legacy TERM override', () => {
    expect(migratePrefsState({ termName: 'screen-256color' }, 2)).toEqual({});
  });

  it('still applies the original color-scheme migration', () => {
    expect(migratePrefsState({ terminalScheme: 'muxus', termName: 'xterm-kitty' }, 0)).toEqual({
      terminalScheme: 'vscode-dark',
    });
  });
});
