import { describe, expect, it } from 'vitest';
import {
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  TERMINAL_SCHEMES,
  terminalColorForHost,
  terminalSchemeIdForHost,
  terminalScheme,
  themeWithColorOverrides,
  themeWithFontColor,
} from '../../../client/src/terminal/palette.js';

const NEW_LIGHT_SCHEME_IDS = [
  'paper',
  'vscode-light',
  'github-light',
  'gruvbox-light',
  'catppuccin-latte',
];

const ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

describe('terminal palettes', () => {
  it('offers the new light schemes with unique ids', () => {
    const ids = TERMINAL_SCHEMES.map((scheme) => scheme.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(NEW_LIGHT_SCHEME_IDS));
    for (const id of NEW_LIGHT_SCHEME_IDS) {
      expect(terminalScheme(id).light).toBe(true);
    }
  });

  it('removes the xterm overview ruler border from every built-in scheme', () => {
    for (const scheme of TERMINAL_SCHEMES) {
      expect(scheme.theme.overviewRulerBorder).toBe('#00000000');
    }
  });

  it('keeps bold white readable on red status backgrounds in light schemes', () => {
    for (const scheme of TERMINAL_SCHEMES.filter(({ light }) => light)) {
      expect(
        contrastRatio(scheme.theme.brightWhite!, scheme.theme.red!),
        scheme.name,
      ).toBeGreaterThan(4);
    }
  });

  it('defines a complete ANSI palette for every offered scheme', () => {
    for (const scheme of TERMINAL_SCHEMES) {
      expect(scheme.theme.background, `${scheme.name} background`).toMatch(/^#[\da-f]{6}$/i);
      expect(scheme.theme.foreground, `${scheme.name} foreground`).toMatch(/^#[\da-f]{6}$/i);
      for (const color of ANSI_COLOR_KEYS) {
        expect(scheme.theme[color], `${scheme.name} ${color}`).toMatch(/^#[\da-f]{6}$/i);
      }
    }
  });

  it('enforces WCAG AA text contrast while rendering every scheme', () => {
    expect(TERMINAL_MINIMUM_CONTRAST_RATIO).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps VS Code dark as the fallback even though light schemes are listed first', () => {
    expect(terminalScheme(undefined).id).toBe('vscode-dark');
    expect(terminalScheme('unknown').id).toBe('vscode-dark');
  });

  it('uses a valid host override and otherwise inherits the application scheme', () => {
    expect(terminalSchemeIdForHost('paper', 'dracula')).toBe('dracula');
    expect(terminalSchemeIdForHost('paper', undefined)).toBe('paper');
    expect(terminalSchemeIdForHost('paper', 'removed-scheme')).toBe('paper');
  });

  it('uses valid host colors and inherits when host metadata is absent or malformed', () => {
    expect(terminalColorForHost('#112233', '#aabbcc')).toBe('#aabbcc');
    expect(terminalColorForHost('#112233', undefined)).toBe('#112233');
    expect(terminalColorForHost('#112233', 'orange')).toBe('#112233');
  });
});

describe('themeWithFontColor', () => {
  const theme = terminalScheme('vscode-dark').theme;

  it('replaces only the foreground when a font color is set', () => {
    const overridden = themeWithFontColor(theme, '#FF8800');

    expect(overridden.foreground).toBe('#FF8800');
    expect({ ...overridden, foreground: theme.foreground }).toEqual(theme);
    // The shared scheme object is never mutated.
    expect(theme.foreground).toBe('#cccccc');
  });

  it('leaves the scheme alone for the empty default and malformed values', () => {
    expect(themeWithFontColor(theme, '')).toBe(theme);
    expect(themeWithFontColor(theme, 'orange')).toBe(theme);
    expect(themeWithFontColor(theme, '#ff0')).toBe(theme);
  });
});

describe('themeWithColorOverrides', () => {
  const theme = terminalScheme('vscode-dark').theme;

  it('replaces the foreground and background without mutating the scheme', () => {
    const overridden = themeWithColorOverrides(theme, '#FF8800', '#102030');

    expect(overridden.foreground).toBe('#FF8800');
    expect(overridden.background).toBe('#102030');
    expect(theme.foreground).toBe('#cccccc');
    expect(theme.background).toBe('#181818');
  });

  it('applies either valid override independently', () => {
    expect(themeWithColorOverrides(theme, '', '#102030')).toMatchObject({
      foreground: theme.foreground,
      background: '#102030',
    });
    expect(themeWithColorOverrides(theme, '#FF8800', '')).toMatchObject({
      foreground: '#FF8800',
      background: theme.background,
    });
  });

  it('leaves the scheme alone when neither override is valid', () => {
    expect(themeWithColorOverrides(theme, '', '')).toBe(theme);
    expect(themeWithColorOverrides(theme, 'orange', '#123')).toBe(theme);
  });
});
