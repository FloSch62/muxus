import { describe, expect, it } from 'vitest';
import { migratePrefsState } from '../../../client/src/state/prefs.js';

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
