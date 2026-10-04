import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_TERMINAL_SCHEMES,
  TERMINAL_SCHEME_FILE_FORMAT,
  createTerminalSchemeDocument,
  customSchemeCopyOf,
  isCustomTerminalSchemeArray,
  mergeCustomTerminalSchemes,
  parseTerminalSchemeFile,
  terminalSchemeFromCustom,
  terminalSchemesFromCustom,
  type CustomTerminalScheme,
} from '../../../client/src/terminal/custom-schemes.js';
import {
  TERMINAL_SCHEMES,
  terminalScheme,
  terminalSchemeIdForHost,
} from '../../../client/src/terminal/palette.js';

const FRAPPE_COLORS = {
  background: '#303446',
  foreground: '#c6d0f5',
  cursor: '#f2d5cf',
  selectionBackground: '#626880',
  black: '#51576d',
  red: '#e78284',
  green: '#a6d189',
  yellow: '#e5c890',
  blue: '#8caaee',
  magenta: '#f4b8e4',
  cyan: '#81c8be',
  white: '#b5bfe2',
  brightBlack: '#626880',
  brightRed: '#e78284',
  brightGreen: '#a6d189',
  brightYellow: '#e5c890',
  brightBlue: '#8caaee',
  brightMagenta: '#f4b8e4',
  brightCyan: '#81c8be',
  brightWhite: '#a5adce',
};

const frappe: CustomTerminalScheme = {
  id: 'scheme-frappe',
  name: 'Catppuccin Frappé',
  colors: FRAPPE_COLORS,
};

/** Catppuccin Frappé as its Windows Terminal port ships it. */
const WINDOWS_TERMINAL_FRAPPE = {
  name: 'Catppuccin Frappe',
  cursorColor: '#F2D5CF',
  selectionBackground: '#626880',
  background: '#303446',
  foreground: '#C6D0F5',
  black: '#51576D',
  red: '#E78284',
  green: '#A6D189',
  yellow: '#E5C890',
  blue: '#8CAAEE',
  purple: '#F4B8E4',
  cyan: '#81C8BE',
  white: '#B5BFE2',
  brightBlack: '#626880',
  brightRed: '#E78284',
  brightGreen: '#A6D189',
  brightYellow: '#E5C890',
  brightBlue: '#8CAAEE',
  brightPurple: '#F4B8E4',
  brightCyan: '#81C8BE',
  brightWhite: '#A5ADCE',
};

const ITERM_NAMES = [
  ['Background Color', '#303446'],
  ['Foreground Color', '#c6d0f5'],
  ['Cursor Color', '#f2d5cf'],
  ['Selection Color', '#626880'],
  ...[
    '#51576d',
    '#e78284',
    '#a6d189',
    '#e5c890',
    '#8caaee',
    '#f4b8e4',
    '#81c8be',
    '#b5bfe2',
    '#626880',
    '#e78284',
    '#a6d189',
    '#e5c890',
    '#8caaee',
    '#f4b8e4',
    '#81c8be',
    '#a5adce',
  ].map((color, index) => [`Ansi ${index} Color`, color]),
] as const;

function itermColor(name: string, hex: string, alpha = 1): string {
  const component = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return `	<key>${name}</key>
	<dict>
		<key>Alpha Component</key>
		<real>${alpha}</real>
		<key>Blue Component</key>
		<real>${component(5)}</real>
		<key>Color Space</key>
		<string>sRGB</string>
		<key>Green Component</key>
		<real>${component(3)}</real>
		<key>Red Component</key>
		<real>${component(1)}</real>
	</dict>`;
}

function itermPreset(colors: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${colors.join('\n')}
</dict>
</plist>
`;
}

describe('custom terminal schemes', () => {
  it('accepts a complete scheme and rejects malformed ones', () => {
    expect(isCustomTerminalSchemeArray([])).toBe(true);
    expect(isCustomTerminalSchemeArray([frappe])).toBe(true);

    expect(isCustomTerminalSchemeArray({})).toBe(false);
    expect(isCustomTerminalSchemeArray([frappe, frappe])).toBe(false);
    expect(isCustomTerminalSchemeArray([{ ...frappe, name: '  ' }])).toBe(false);
    expect(isCustomTerminalSchemeArray([{ ...frappe, id: 'x'.repeat(65) }])).toBe(false);
    expect(
      isCustomTerminalSchemeArray([{ ...frappe, colors: { ...FRAPPE_COLORS, red: 'red' } }]),
    ).toBe(false);
    const { cursor: _cursor, ...withoutCursor } = FRAPPE_COLORS;
    expect(isCustomTerminalSchemeArray([{ ...frappe, colors: withoutCursor }])).toBe(false);
    expect(
      isCustomTerminalSchemeArray([{ ...frappe, colors: { ...FRAPPE_COLORS, extra: '#000000' } }]),
    ).toBe(false);
    expect(
      isCustomTerminalSchemeArray(
        Array.from({ length: MAX_CUSTOM_TERMINAL_SCHEMES + 1 }, (_, index) => ({
          ...frappe,
          id: `scheme-${index}`,
        })),
      ),
    ).toBe(false);
  });

  it('never lets a custom scheme take a built-in id', () => {
    expect(isCustomTerminalSchemeArray([{ ...frappe, id: 'dracula' }])).toBe(false);
  });

  it('turns a custom scheme into a terminal theme', () => {
    const scheme = terminalSchemeFromCustom(frappe);

    expect(scheme).toMatchObject({ id: 'scheme-frappe', name: 'Catppuccin Frappé' });
    expect(scheme.light).toBeUndefined();
    expect(scheme.theme).toEqual({
      ...FRAPPE_COLORS,
      cursorAccent: '#303446',
      overviewRulerBorder: '#00000000',
    });
  });

  it('classifies a scheme by its background, as the built-in schemes are', () => {
    for (const builtin of TERMINAL_SCHEMES) {
      const copy = customSchemeCopyOf(builtin, []);
      expect(!!terminalSchemeFromCustom(copy).light, builtin.name).toBe(!!builtin.light);
    }
  });

  it('keeps the converted scheme stable until its stored scheme changes', () => {
    const other: CustomTerminalScheme = { ...frappe, id: 'scheme-other', name: 'Other' };
    const stored = [frappe, other];
    const converted = terminalSchemesFromCustom(stored);

    expect(terminalSchemesFromCustom(stored)).toBe(converted);

    const edited = [frappe, { ...other, name: 'Renamed' }];
    const reconverted = terminalSchemesFromCustom(edited);
    expect(reconverted[0]).toBe(converted[0]);
    expect(reconverted[1]).not.toBe(converted[1]);
    expect(reconverted[1]!.name).toBe('Renamed');
  });

  it('resolves custom scheme ids next to the built-in ones', () => {
    const custom = terminalSchemesFromCustom([frappe]);

    expect(terminalScheme('scheme-frappe', custom).name).toBe('Catppuccin Frappé');
    expect(terminalScheme('dracula', custom).id).toBe('dracula');
    expect(terminalScheme('scheme-deleted', custom).id).toBe('vscode-dark');
    expect(terminalScheme('scheme-frappe').id).toBe('vscode-dark');
    expect(terminalSchemeIdForHost('paper', 'scheme-frappe', custom)).toBe('scheme-frappe');
    expect(terminalSchemeIdForHost('paper', 'scheme-deleted', custom)).toBe('paper');
  });
});

describe('copying a scheme', () => {
  it('starts a custom scheme from a built-in one under a free name', () => {
    const mocha = terminalScheme('catppuccin-mocha');
    const copy = customSchemeCopyOf(mocha, []);

    expect(copy.name).toBe('Catppuccin Mocha copy');
    expect(copy.id).not.toBe(mocha.id);
    expect(copy.colors.background).toBe('#1e1e2e');
    expect(copy.colors.magenta).toBe('#f5c2e7');
    expect(isCustomTerminalSchemeArray([copy])).toBe(true);

    const second = customSchemeCopyOf(mocha, [copy]);
    expect(second.name).toBe('Catppuccin Mocha copy 2');
    expect(second.id).not.toBe(copy.id);
  });

  it('flattens a translucent selection over the background', () => {
    // Mocha selects with rgba(88, 91, 112, 0.6) on #1e1e2e.
    expect(customSchemeCopyOf(terminalScheme('catppuccin-mocha'), []).colors.selectionBackground)
      .toBe('#414356');
  });
});

describe('scheme files', () => {
  it('round-trips an export', () => {
    const document = createTerminalSchemeDocument([frappe]);

    expect(document.format).toBe(TERMINAL_SCHEME_FILE_FORMAT);
    expect(parseTerminalSchemeFile(JSON.stringify(document), 'export.json')).toEqual([frappe]);
  });

  it('refuses to export nothing', () => {
    expect(() => createTerminalSchemeDocument([])).toThrow('at least one');
  });

  it('rejects an export from a newer version or with invalid schemes', () => {
    const document = createTerminalSchemeDocument([frappe]);

    expect(() =>
      parseTerminalSchemeFile(JSON.stringify({ ...document, version: 2 }), 'export.json'),
    ).toThrow('version 2 is not supported');
    expect(() =>
      parseTerminalSchemeFile(
        JSON.stringify({ ...document, schemes: [{ ...frappe, id: 'nord' }] }),
        'export.json',
      ),
    ).toThrow('incomplete or invalid');
  });

  it('imports a Windows Terminal color scheme', () => {
    const [scheme] = parseTerminalSchemeFile(
      JSON.stringify(WINDOWS_TERMINAL_FRAPPE),
      'frappe.json',
    );

    expect(scheme!.name).toBe('Catppuccin Frappe');
    expect(scheme!.colors).toEqual(FRAPPE_COLORS);
    expect(isCustomTerminalSchemeArray([scheme])).toBe(true);
  });

  it('imports every scheme of a Windows Terminal settings file', () => {
    const schemes = parseTerminalSchemeFile(
      JSON.stringify({
        schemes: [WINDOWS_TERMINAL_FRAPPE, { ...WINDOWS_TERMINAL_FRAPPE, name: undefined }],
      }),
      'settings.json',
    );

    expect(schemes.map((scheme) => scheme.name)).toEqual(['Catppuccin Frappe', 'settings 2']);
    expect(new Set(schemes.map((scheme) => scheme.id)).size).toBe(2);
  });

  it('derives the cursor and the selection when a scheme leaves them out', () => {
    const { cursorColor: _cursor, selectionBackground: _selection, ...bare } =
      WINDOWS_TERMINAL_FRAPPE;
    const [scheme] = parseTerminalSchemeFile(JSON.stringify(bare), 'frappe.json');

    expect(scheme!.colors.cursor).toBe('#c6d0f5');
    // The text color at 30% over the background.
    expect(scheme!.colors.selectionBackground).toBe('#5d637b');
  });

  it('reads short hex and rgb notations', () => {
    const [scheme] = parseTerminalSchemeFile(
      JSON.stringify({
        ...WINDOWS_TERMINAL_FRAPPE,
        black: '#000',
        white: 'rgb(255, 255, 255)',
        selectionBackground: 'rgba(255, 255, 255, 0.5)',
      }),
      'scheme.json',
    );

    expect(scheme!.colors.black).toBe('#000000');
    expect(scheme!.colors.white).toBe('#ffffff');
    expect(scheme!.colors.selectionBackground).toBe('#989aa3');
  });

  it('names the color a JSON scheme is missing', () => {
    const { purple: _purple, ...incomplete } = WINDOWS_TERMINAL_FRAPPE;

    expect(() => parseTerminalSchemeFile(JSON.stringify(incomplete), 'frappe.json')).toThrow(
      'Catppuccin Frappe: the color "magenta (or purple)" is missing',
    );
    expect(() => parseTerminalSchemeFile('{"format":"muxus-backup"}', 'backup.json')).toThrow(
      'backup: the color "background" is missing',
    );
  });

  it('imports an iTerm2 preset and names it after the file', () => {
    const [scheme] = parseTerminalSchemeFile(
      itermPreset(ITERM_NAMES.map(([name, color]) => itermColor(name!, color!))),
      'Catppuccin Frappe.itermcolors',
    );

    expect(scheme!.name).toBe('Catppuccin Frappe');
    expect(scheme!.colors).toEqual(FRAPPE_COLORS);
  });

  it('flattens a translucent iTerm2 selection and reports a missing color', () => {
    const colors = ITERM_NAMES.map(([name, color]) =>
      itermColor(name!, color!, name === 'Selection Color' ? 0.5 : 1),
    );
    const [scheme] = parseTerminalSchemeFile(itermPreset(colors), 'half.itermcolors');
    expect(scheme!.colors.selectionBackground).toBe('#494e63');

    const withoutRed = colors.filter((color) => !color.includes('<key>Ansi 1 Color</key>'));
    expect(() => parseTerminalSchemeFile(itermPreset(withoutRed), 'half.itermcolors')).toThrow(
      'half: the color "red" is missing',
    );
  });

  it('rejects files that are not a color scheme', () => {
    expect(() => parseTerminalSchemeFile('not json', 'notes.txt')).toThrow('neither');
    expect(() => parseTerminalSchemeFile('<html></html>', 'page.html')).toThrow('neither');
    expect(() => parseTerminalSchemeFile('[]', 'empty.json')).toThrow('no color schemes');
    expect(() => parseTerminalSchemeFile('[42]', 'numbers.json')).toThrow('does not describe');
  });
});

describe('merging imported schemes', () => {
  it('replaces a scheme with a known id in place and keeps the others', () => {
    const other: CustomTerminalScheme = { ...frappe, id: 'scheme-other', name: 'Other' };
    const updated: CustomTerminalScheme = { ...frappe, name: 'Frappé, retuned' };

    expect(mergeCustomTerminalSchemes([frappe, other], [updated])).toEqual([updated, other]);
  });

  it('adds an unknown scheme under a name that is still free', () => {
    const again: CustomTerminalScheme = { ...frappe, id: 'scheme-again' };
    const dracula: CustomTerminalScheme = { ...frappe, id: 'scheme-dracula', name: 'Dracula' };

    const merged = mergeCustomTerminalSchemes([frappe], [again, dracula]);

    expect(merged.map((scheme) => scheme.name)).toEqual([
      'Catppuccin Frappé',
      'Catppuccin Frappé 2',
      // The built-in scheme already uses the plain name.
      'Dracula 2',
    ]);
    expect(isCustomTerminalSchemeArray(merged)).toBe(true);
  });

  it('refuses an import beyond the scheme limit', () => {
    const full = Array.from({ length: MAX_CUSTOM_TERMINAL_SCHEMES }, (_, index) => ({
      ...frappe,
      id: `scheme-${index}`,
      name: `Scheme ${index}`,
    }));

    expect(() => mergeCustomTerminalSchemes(full, [frappe])).toThrow('exceed the limit');
  });
});
