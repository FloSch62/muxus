import { describe, expect, it } from 'vitest';
import {
  INTERFACE_ZOOM_STEPS,
  MAX_INTERFACE_ZOOM,
  MIN_INTERFACE_ZOOM,
  clampInterfaceZoom,
  interfaceZoomLabel,
} from '../../../client/src/interface-zoom.js';
import { DEFAULT_SIDEBAR_WIDTH } from '../../../client/src/sidebar-width.js';
import {
  MONO_FONT_FALLBACK,
  isLocalShellProfileArray,
  migratePrefsState,
  terminalFontStack,
} from '../../../client/src/state/prefs.js';

const ubuntuProfile = {
  id: 'ubuntu',
  name: 'Ubuntu',
  shell: 'wsl.exe',
  args: ['-d', 'Ubuntu'],
  cwd: 'C:\\work',
  startupCommand: 'cd project',
};

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

describe('migratePrefsState folder preferences', () => {
  it('keeps well-formed folder state', () => {
    const persisted = {
      sidebarCollapsedFolders: ['folder:prod'],
      sidebarEmptyFolders: ['Prod/EU'],
      sidebarFolderStyles: { 'folder:prod': { color: '#ef5350', icon: 'cloud' } },
    };

    expect(migratePrefsState(persisted, 4)).toEqual(persisted);
  });

  it('drops folder state of the wrong shape so readers get the defaults', () => {
    const persisted = {
      monoFontSize: 16,
      sidebarCollapsedFolders: 'folder:prod',
      sidebarEmptyFolders: [1, 2],
      sidebarFolderStyles: { 'folder:prod': 'red' },
    };

    expect(migratePrefsState(persisted, 4)).toEqual({ monoFontSize: 16 });
    // The stored snapshot itself is left untouched.
    expect(persisted.sidebarCollapsedFolders).toBe('folder:prod');
  });

  it('rejects a style record carrying unknown keys', () => {
    const migrated = migratePrefsState(
      { sidebarFolderStyles: { 'folder:prod': { colour: '#ef5350' } } },
      4,
    ) as Record<string, unknown>;

    expect(migrated.sidebarFolderStyles).toBeUndefined();
  });
});

describe('migratePrefsState sidebar width', () => {
  it('widens a stored copy of the old default but keeps a dragged width', () => {
    expect(migratePrefsState({ sidebarWidth: 248 }, 5)).toEqual({
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    });
    expect(migratePrefsState({ sidebarWidth: 320 }, 5)).toEqual({ sidebarWidth: 320 });
    expect(migratePrefsState({ sidebarWidth: 248 }, 6)).toEqual({ sidebarWidth: 248 });
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

describe('local shell profile preferences', () => {
  it('keeps complete profiles and rejects duplicate IDs', () => {
    expect(isLocalShellProfileArray([ubuntuProfile])).toBe(true);
    expect(isLocalShellProfileArray([ubuntuProfile, { ...ubuntuProfile }])).toBe(false);
  });

  it('drops malformed persisted profiles without changing other preferences', () => {
    expect(
      migratePrefsState(
        {
          monoFontSize: 16,
          localShellProfiles: [{ ...ubuntuProfile, args: '-d Ubuntu' }],
        },
        6,
      ),
    ).toEqual({ monoFontSize: 16 });
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

describe('migratePrefsState folder order', () => {
  it('keeps a well-formed order map', () => {
    const persisted = { sidebarFolderOrder: { root: ['folder:prod', 'folder:lab'] } };
    expect(migratePrefsState(persisted, 4)).toEqual(persisted);
  });

  it('drops an order map of the wrong shape', () => {
    const migrated = migratePrefsState(
      { sidebarFolderOrder: { root: 'folder:prod' } },
      4,
    ) as Record<string, unknown>;
    expect(migrated.sidebarFolderOrder).toBeUndefined();
  });
});
