import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SEARCH_INDEX,
  searchSettings,
  settingsTitleKey,
  type SettingsSearchContext,
} from '../../../client/src/settings-search.js';
import type { SettingsSection } from '../../../client/src/state/ui.js';

const SECTION_LABELS: Record<SettingsSection, string> = {
  appearance: 'Appearance',
  terminal: 'Terminal',
  'local-shells': 'Local shells',
  logging: 'Session logging',
  highlighting: 'Highlighting',
  behavior: 'Behavior',
  x11: 'X11 forwarding',
  keyboard: 'Keyboard',
  passwords: 'Passwords',
  data: 'Backup & data',
  debug: 'Debug',
  about: 'About',
};

const linux: SettingsSearchContext = {
  sectionLabel: (section) => SECTION_LABELS[section],
  desktop: true,
  platform: 'linux',
};

const labels = (query: string, context = linux) =>
  searchSettings(query, context).map((entry) => entry.label);

describe('searchSettings', () => {
  it('finds nothing without a query', () => {
    expect(labels('')).toEqual([]);
    expect(labels('   ')).toEqual([]);
  });

  it('puts settings whose label starts with the query first', () => {
    expect(labels('font').slice(0, 2)).toEqual(['Font family', 'Font size']);
    expect(labels('dark')[0]).toBe('Dark terminal theme');
  });

  it('matches every word, in any field and in any order', () => {
    expect(labels('ssh keepalive')).toEqual(['SSH keepalive interval']);
    expect(labels('keepalive ssh')).toEqual(['SSH keepalive interval']);
    expect(labels('dark mode')).toContain('Theme');
    expect(labels('ctrl+d')).toEqual(['Close the tab when its shell exits']);
  });

  it('ignores case, accents, spaces and punctuation inside a word', () => {
    expect(labels('OSC52')).toEqual(['Allow terminal clipboard writes (OSC 52)']);
    expect(labels('webgl')).toEqual(['GPU renderer (WebGL)']);
    expect(labels('Thème')).toContain('Theme');
  });

  it('finds every setting of a section by its name', () => {
    const x11 = searchSettings('x11 forwarding', { ...linux, platform: 'win32' });
    expect(x11.map((entry) => entry.section)).toContain('x11');
    expect(x11.find((entry) => entry.label === 'Enable X11 forwarding')).toBeDefined();
  });

  it('leaves out settings that do not exist here', () => {
    expect(labels('wsl distributions')).toEqual([]);
    expect(labels('wsl distributions', { ...linux, platform: 'win32' })).toEqual([
      'WSL distributions',
      'List installed distributions',
    ]);
    expect(labels('ssh links', { ...linux, desktop: false })).toEqual([]);
    expect(labels('ssh links')).toEqual(['SSH links']);
  });

  it('drops the count from a group title', () => {
    expect(settingsTitleKey('Saved profiles · 3')).toBe('Saved profiles');
    expect(settingsTitleKey('Vault')).toBe('Vault');
  });
});

describe('the settings search index', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const components = path.resolve(here, '../../../client/src/components');
  const read = (file: string) => readFileSync(path.join(components, file), 'utf8');

  /** Components that render one section, or a part of it. */
  const FILE_SECTIONS: Record<string, SettingsSection> = {
    'AboutSection.tsx': 'about',
    'DesktopUpdateControls.tsx': 'about',
    'CustomTerminalSchemeSettings.tsx': 'appearance',
    'DataTransferSection.tsx': 'data',
    'HighlightProfilesSection.tsx': 'highlighting',
    'LinkHandlerSettings.tsx': 'behavior',
    'LocalShellProfilesSection.tsx': 'local-shells',
    'PasswordVaultSection.tsx': 'passwords',
    'X11Section.tsx': 'x11',
  };
  /** The section components inside SettingsDialog.tsx. */
  const DIALOG_FUNCTION_SECTIONS: Record<string, SettingsSection> = {
    AppearanceSection: 'appearance',
    LayoutSettings: 'appearance',
    TerminalSection: 'terminal',
    BehaviorSection: 'behavior',
    KeyboardSection: 'keyboard',
    SessionLoggingSection: 'logging',
    LogFileSettings: 'logging',
    HistoryStorageSettings: 'logging',
    DebugSection: 'debug',
  };
  /** Fields of the profile or scheme picked in a list, found through their group. */
  const LIST_EDITOR_ROWS = new Set(['Scheme', 'Profile', 'Name']);

  /** The text of the `{…}` expression that starts at `open`. */
  function braced(source: string, open: number): string {
    let depth = 0;
    for (let index = open; index < source.length; index++) {
      if (source[index] === '{') depth++;
      if (source[index] === '}' && --depth === 0) return source.slice(open, index + 1);
    }
    return '';
  }

  function settingsInSource(section: SettingsSection, source: string, rows: Set<string>, groups: Set<string>) {
    for (const [, label] of source.matchAll(/<SettingRow\s+label="([^"]+)"/g)) {
      if (!LIST_EDITOR_ROWS.has(label!)) rows.add(`${section}|${label}`);
    }
    // Link handlers label their rows from a table.
    for (const [, label] of source.matchAll(/\{ scheme: '\w+', label: '([^']+)' \}/g)) {
      rows.add(`${section}|${label}`);
    }
    for (const [, title] of source.matchAll(/<SettingsGroup\s+title="([^"]+)"/g)) {
      groups.add(`${section}|${title}`);
    }
    // A counted title, `Saved profiles · 3`, falls back to its bare name.
    for (const match of source.matchAll(/<SettingsGroup\s+title=\{/g)) {
      const expression = braced(source, match.index + match[0].length - 1);
      const fallback = [...expression.matchAll(/'([^']+)'/g)].at(-1)?.[1];
      if (fallback) groups.add(`${section}|${fallback}`);
    }
  }

  function sourceSettings() {
    const rows = new Set<string>();
    const groups = new Set<string>();
    for (const [file, section] of Object.entries(FILE_SECTIONS)) {
      settingsInSource(section, read(file), rows, groups);
    }
    for (const part of read('SettingsDialog.tsx').split(/^(?=(?:export )?function \w+)/m)) {
      const name = /^(?:export )?function (\w+)/.exec(part)?.[1] ?? '';
      const section = DIALOG_FUNCTION_SECTIONS[name];
      if (section) settingsInSource(section, part, rows, groups);
      else expect(part, `${name} renders settings: map it to its section`).not.toMatch(/<Setting(Row|sGroup)\b/);
    }
    return { rows, groups };
  }

  function indexedSettings() {
    const rows = new Set<string>();
    const groups = new Set<string>();
    for (const entry of SETTINGS_SEARCH_INDEX) {
      if (entry.kind === 'group') groups.add(`${entry.section}|${entry.label}`);
      else rows.add(`${entry.section}|${entry.row ?? entry.label}`);
      if (entry.group) groups.add(`${entry.section}|${entry.group}`);
    }
    return { rows, groups };
  }

  it('lists every setting row and group, in the section that shows it', () => {
    const source = sourceSettings();
    const indexed = indexedSettings();
    expect([...indexed.rows].sort()).toEqual([...source.rows].sort());
    expect([...indexed.groups].sort()).toEqual([...source.groups].sort());
  });

  it('knows every component that renders settings', () => {
    const rendering = readdirSync(components)
      .filter((file) => file.endsWith('.tsx') && file !== 'SettingsDialog.tsx')
      .filter((file) => /<Setting(Row|sGroup)\b/.test(read(file)));
    expect(rendering.sort()).toEqual(Object.keys(FILE_SECTIONS).sort());
  });

  it('lists each setting once', () => {
    const keys = SETTINGS_SEARCH_INDEX.map((entry) => `${entry.section}|${entry.kind ?? 'row'}|${entry.label}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
