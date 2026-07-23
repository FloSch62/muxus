import { describe, expect, it } from 'vitest';
import {
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  TERMINAL_SCHEMES,
  terminalScheme,
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
});
