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
  DEFAULT_INACTIVE_PANE_DIM_STRENGTH,
  MONO_FONT_FALLBACK,
  clampInactivePaneDimStrength,
  isLocalShellProfileArray,
  migratePrefsState,
  paneFocusOpacity,
  terminalFontStack,
  terminalSchemeIdForMode,
  usePrefsStore,
} from '../../../client/src/state/prefs.js';

const ubuntuProfile = {
  id: 'ubuntu',
  name: 'Ubuntu',
  shell: 'wsl.exe',
  args: ['-d', 'Ubuntu'],
  cwd: 'C:\\work',
  startupCommand: 'cd project',
};

describe('appearance preference', () => {
  it('defaults new installations to the system appearance', () => {
    expect(usePrefsStore.getInitialState().themeMode).toBe('os');
  });

  it.each(['light', 'dark'] as const)(
    'retains an existing explicit %s preference during migration',
    (themeMode) => {
      expect(migratePrefsState({ themeMode }, 0)).toMatchObject({ themeMode });
    },
  );

  it('falls back to System when a persisted preference is invalid', () => {
    expect(migratePrefsState({ themeMode: 'sepia', monoFontSize: 16 }, 7)).toEqual({
      monoFontSize: 16,
    });
  });
});

describe('terminal file link activation preference', () => {
  it('defaults to Alt + left click so normal terminal selection remains available', () => {
    expect(usePrefsStore.getInitialState().terminalFileLinkActivation).toBe('alt');
  });

  it.each(['direct', 'alt', 'ctrl', 'meta'] as const)(
    'keeps the valid %s activation setting during migration',
    (terminalFileLinkActivation) => {
      expect(migratePrefsState({ terminalFileLinkActivation }, 12)).toEqual({
        terminalFileLinkActivation,
      });
    },
  );

  it('drops malformed persisted activation settings', () => {
    expect(
      migratePrefsState({ terminalFileLinkActivation: 'double-click', monoFontSize: 16 }, 12),
    ).toEqual({ monoFontSize: 16 });
  });
});

describe('split pane focus preferences', () => {
  it('leaves both indicators off by default with dimming set to 15%', () => {
    const initial = usePrefsStore.getInitialState();
    expect(initial.activePaneBorder).toBe(false);
    expect(initial.dimInactivePanes).toBe(false);
    expect(initial.inactivePaneDimStrength).toBe(DEFAULT_INACTIVE_PANE_DIM_STRENGTH);
  });

  it('keeps valid choices and drops malformed persisted values', () => {
    expect(
      migratePrefsState(
        { activePaneBorder: false, dimInactivePanes: true, inactivePaneDimStrength: 0.4 },
        10,
      ),
    ).toEqual({ activePaneBorder: false, dimInactivePanes: true, inactivePaneDimStrength: 0.4 });
    expect(
      migratePrefsState(
        { activePaneBorder: 'yes', dimInactivePanes: 1, inactivePaneDimStrength: 0.95 },
        10,
      ),
    ).toEqual({});
  });

  it('dims only inactive panes and bounds presentation opacity', () => {
    expect(paneFocusOpacity(true, true, 0.4)).toBe(1);
    expect(paneFocusOpacity(false, false, 0.4)).toBe(1);
    expect(paneFocusOpacity(false, true, 0.4)).toBe(0.6);
    expect(clampInactivePaneDimStrength(Number.NaN)).toBe(DEFAULT_INACTIVE_PANE_DIM_STRENGTH);
    expect(paneFocusOpacity(false, true, 1)).toBe(0.4);
  });
});

describe('tab number visibility preference', () => {
  it('defaults to revealing numbers while Alt is held', () => {
    expect(usePrefsStore.getInitialState().tabNumberVisibility).toBe('shortcut');
  });

  it('keeps valid persisted values and drops invalid ones', () => {
    expect(migratePrefsState({ tabNumberVisibility: 'always' }, 9)).toEqual({
      tabNumberVisibility: 'always',
    });
    expect(migratePrefsState({ tabNumberVisibility: 'sometimes' }, 9)).toEqual({});
    expect(migratePrefsState({ tabNumberVisibility: 'never' }, 9)).toEqual({});
  });
});

describe('terminal color scheme preferences', () => {
  it('defaults new installations to matching light and dark schemes', () => {
    const initial = usePrefsStore.getInitialState();
    expect(initial.lightTerminalScheme).toBe('vscode-light');
    expect(initial.darkTerminalScheme).toBe('vscode-dark');
  });

  it('selects the scheme for the effective appearance', () => {
    const prefs = { lightTerminalScheme: 'paper', darkTerminalScheme: 'dracula' };
    expect(terminalSchemeIdForMode(prefs, 'light')).toBe('paper');
    expect(terminalSchemeIdForMode(prefs, 'dark')).toBe('dracula');
  });

  it('migrates a single saved scheme into both appearances', () => {
    expect(migratePrefsState({ terminalScheme: 'nord' }, 8)).toEqual({
      lightTerminalScheme: 'nord',
      darkTerminalScheme: 'nord',
    });
  });

  it('keeps split selections when reprocessing an older snapshot', () => {
    expect(
      migratePrefsState(
        {
          terminalScheme: 'nord',
          lightTerminalScheme: 'paper',
          darkTerminalScheme: 'dracula',
        },
        8,
      ),
    ).toEqual({
      lightTerminalScheme: 'paper',
      darkTerminalScheme: 'dracula',
    });
  });
});

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
      lightTerminalScheme: 'vscode-dark',
      darkTerminalScheme: 'vscode-dark',
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

describe('keyword highlighting profile preferences', () => {
  const profile = {
    id: 'nokia-sros',
    name: 'Nokia SR OS',
    rules: [
      {
        id: 'alarm',
        keyword: 'MAJOR',
        foreground: '#ffffff',
        background: '#b91c1c',
        caseSensitive: true,
        wholeWord: true,
      },
    ],
  };

  it('keeps valid reusable profiles during preference migration', () => {
    expect(migratePrefsState({ keywordHighlightProfiles: [profile] }, 11)).toEqual({
      keywordHighlightProfiles: [profile],
    });
  });

  it('drops malformed reusable profiles without changing other preferences', () => {
    expect(
      migratePrefsState(
        {
          monoFontSize: 16,
          keywordHighlightProfiles: [{ ...profile, rules: [{ ...profile.rules[0], foreground: 'red' }] }],
        },
        11,
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
