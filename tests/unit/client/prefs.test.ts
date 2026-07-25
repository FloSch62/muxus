import { describe, expect, it } from 'vitest';
import {
  INTERFACE_ZOOM_STEPS,
  MAX_INTERFACE_ZOOM,
  MIN_INTERFACE_ZOOM,
  clampInterfaceZoom,
  interfaceZoomLabel,
} from '../../../client/src/interface-zoom.js';
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

describe('interface zoom', () => {
  it('keeps the window scale inside a usable range', () => {
    expect(clampInterfaceZoom(1)).toBe(1);
    expect(clampInterfaceZoom(0.1)).toBe(MIN_INTERFACE_ZOOM);
    expect(clampInterfaceZoom(9)).toBe(MAX_INTERFACE_ZOOM);
    expect(clampInterfaceZoom(Number.NaN)).toBe(1);
  });

  it('offers 100% as a step and labels steps as percentages', () => {
    expect(INTERFACE_ZOOM_STEPS).toContain(1);
    expect(INTERFACE_ZOOM_STEPS.every((step) => clampInterfaceZoom(step) === step)).toBe(true);
    expect(interfaceZoomLabel(1.25)).toBe('125%');
  });
});
