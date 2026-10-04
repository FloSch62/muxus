import { newPreferenceId } from '../command-buttons.js';
import {
  TERMINAL_SCHEMES,
  withoutOverviewRulerBorder,
  type TerminalScheme,
} from './palette.js';

export const TERMINAL_SCHEME_FILE_FORMAT = 'muxus-terminal-color-schemes';
export const TERMINAL_SCHEME_FILE_VERSION = 1;
export const MAX_TERMINAL_SCHEME_FILE_BYTES = 1024 * 1024;
export const MAX_CUSTOM_TERMINAL_SCHEMES = 100;
/** Host metadata stores its scheme override in at most 64 characters. */
const MAX_SCHEME_ID_LENGTH = 64;
export const MAX_TERMINAL_SCHEME_NAME_LENGTH = 100;
/** Names taken from a file or another scheme leave room for " copy" and a number. */
const MAX_DERIVED_NAME_LENGTH = 80;

export const SCHEME_BASE_COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'selectionBackground',
] as const;

export const SCHEME_ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const;

export const SCHEME_BRIGHT_ANSI_COLOR_KEYS = [
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

const SCHEME_COLOR_KEYS = [
  ...SCHEME_BASE_COLOR_KEYS,
  ...SCHEME_ANSI_COLOR_KEYS,
  ...SCHEME_BRIGHT_ANSI_COLOR_KEYS,
] as const;

export type CustomSchemeColorKey = (typeof SCHEME_COLOR_KEYS)[number];

/** Every color is an opaque `#rrggbb`, which is what a color well edits. */
export type CustomSchemeColors = Record<CustomSchemeColorKey, string>;

/** A terminal color scheme the user created or imported, kept in preferences. */
export interface CustomTerminalScheme {
  id: string;
  name: string;
  colors: CustomSchemeColors;
}

export interface TerminalSchemeDocument {
  format: typeof TERMINAL_SCHEME_FILE_FORMAT;
  version: typeof TERMINAL_SCHEME_FILE_VERSION;
  createdAt: string;
  schemes: CustomTerminalScheme[];
}

const BUILTIN_SCHEME_IDS = new Set(TERMINAL_SCHEMES.map((scheme) => scheme.id));
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function isCustomTerminalSchemeArray(value: unknown): value is CustomTerminalScheme[] {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_TERMINAL_SCHEMES) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (
      !isRecord(entry) ||
      !boundedString(entry.id, MAX_SCHEME_ID_LENGTH) ||
      // A built-in id would be shadowed by the built-in scheme.
      BUILTIN_SCHEME_IDS.has(entry.id) ||
      ids.has(entry.id) ||
      !boundedString(entry.name, MAX_TERMINAL_SCHEME_NAME_LENGTH) ||
      !entry.name.trim() ||
      !isSchemeColors(entry.colors)
    ) {
      return false;
    }
    ids.add(entry.id);
    return true;
  });
}

function isSchemeColors(value: unknown): value is CustomSchemeColors {
  return (
    isRecord(value) &&
    Object.keys(value).length === SCHEME_COLOR_KEYS.length &&
    SCHEME_COLOR_KEYS.every((key) => {
      const color = value[key];
      return typeof color === 'string' && HEX_COLOR_RE.test(color);
    })
  );
}

// Preferences never mutate a stored scheme, so the object itself keys the
// cache: an open terminal re-themes only when its own scheme was edited.
const SCHEME_CACHE = new WeakMap<CustomTerminalScheme, TerminalScheme>();
const SCHEME_LIST_CACHE = new WeakMap<
  readonly CustomTerminalScheme[],
  readonly TerminalScheme[]
>();

/** A custom scheme in the shape the terminal and the scheme pickers consume. */
export function terminalSchemeFromCustom(custom: CustomTerminalScheme): TerminalScheme {
  let scheme = SCHEME_CACHE.get(custom);
  if (!scheme) {
    scheme = {
      id: custom.id,
      name: custom.name,
      ...(isLightColor(custom.colors.background) ? { light: true } : {}),
      theme: withoutOverviewRulerBorder({
        ...custom.colors,
        cursorAccent: custom.colors.background,
      }),
    };
    SCHEME_CACHE.set(custom, scheme);
  }
  return scheme;
}

export function terminalSchemesFromCustom(
  customSchemes: readonly CustomTerminalScheme[],
): readonly TerminalScheme[] {
  let schemes = SCHEME_LIST_CACHE.get(customSchemes);
  if (!schemes) {
    schemes = customSchemes.map(terminalSchemeFromCustom);
    SCHEME_LIST_CACHE.set(customSchemes, schemes);
  }
  return schemes;
}

/** A new custom scheme that starts out as a copy of a built-in or custom one. */
export function customSchemeCopyOf(
  scheme: TerminalScheme,
  existing: readonly CustomTerminalScheme[],
): CustomTerminalScheme {
  return {
    id: newPreferenceId('scheme'),
    name: unusedSchemeName(`${scheme.name.slice(0, MAX_DERIVED_NAME_LENGTH)} copy`, existing),
    colors: opaqueSchemeColors(scheme.theme, scheme.name),
  };
}

/** Build the portable file shared by the custom scheme import and export. */
export function createTerminalSchemeDocument(
  schemes: readonly CustomTerminalScheme[],
): TerminalSchemeDocument {
  if (!isCustomTerminalSchemeArray(schemes) || schemes.length === 0) {
    throw new Error('Select at least one valid color scheme to export.');
  }
  return {
    format: TERMINAL_SCHEME_FILE_FORMAT,
    version: TERMINAL_SCHEME_FILE_VERSION,
    createdAt: new Date().toISOString(),
    schemes: schemes.map(copyScheme),
  };
}

/**
 * Read the schemes in an untrusted file: a Muxus scheme export, a Windows
 * Terminal color scheme (one object, a list, or the "schemes" of a settings
 * file), or an iTerm2 `.itermcolors` preset. Only a Muxus export carries ids;
 * schemes from the other formats get new ones and are named after the file
 * when they do not name themselves.
 */
export function parseTerminalSchemeFile(text: string, filename: string): CustomTerminalScheme[] {
  const fileSchemeName = schemeNameFromFilename(filename);
  if (text.trimStart().startsWith('<')) return [parseItermColors(text, fileSchemeName)];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This file is neither a JSON color scheme nor an iTerm2 color preset.');
  }
  if (isRecord(parsed) && parsed.format === TERMINAL_SCHEME_FILE_FORMAT) {
    return parseSchemeDocument(parsed);
  }
  let entries: unknown[] = [parsed];
  if (Array.isArray(parsed)) entries = parsed;
  else if (isRecord(parsed) && Array.isArray(parsed.schemes)) entries = parsed.schemes;
  if (entries.length === 0) throw new Error('This file contains no color schemes.');
  if (entries.length > MAX_CUSTOM_TERMINAL_SCHEMES) {
    throw new Error(
      `This file contains more than ${MAX_CUSTOM_TERMINAL_SCHEMES} color schemes.`,
    );
  }
  return entries.map((entry, index) =>
    parseJsonScheme(
      entry,
      entries.length === 1 ? fileSchemeName : `${fileSchemeName} ${index + 1}`,
    ),
  );
}

/**
 * Add imported schemes to the user's own. A scheme whose id is already known
 * is replaced in place, so terminal themes and hosts that use it keep
 * following it; every other scheme is added under a name that is still free.
 */
export function mergeCustomTerminalSchemes(
  current: readonly CustomTerminalScheme[],
  imported: readonly CustomTerminalScheme[],
): CustomTerminalScheme[] {
  const merged = [...current];
  for (const scheme of imported) {
    const index = merged.findIndex((candidate) => candidate.id === scheme.id);
    if (index >= 0) merged[index] = scheme;
    else merged.push({ ...scheme, name: unusedSchemeName(scheme.name, merged) });
  }
  if (merged.length > MAX_CUSTOM_TERMINAL_SCHEMES) {
    throw new Error(
      `This import would exceed the limit of ${MAX_CUSTOM_TERMINAL_SCHEMES} custom color schemes. Delete an existing scheme and try again.`,
    );
  }
  return merged;
}

function parseSchemeDocument(document: Record<string, unknown>): CustomTerminalScheme[] {
  if (document.version !== TERMINAL_SCHEME_FILE_VERSION) {
    throw new Error(
      typeof document.version === 'number'
        ? `Color scheme file version ${document.version} is not supported.`
        : 'This file is missing a supported color scheme version.',
    );
  }
  if (!isCustomTerminalSchemeArray(document.schemes) || document.schemes.length === 0) {
    throw new Error('The color scheme file is incomplete or invalid.');
  }
  return document.schemes.map(copyScheme);
}

function parseJsonScheme(entry: unknown, fallbackName: string): CustomTerminalScheme {
  if (!isRecord(entry)) throw new Error('This file does not describe a terminal color scheme.');
  const name = derivedSchemeName(entry.name) ?? fallbackName;
  const colors = isRecord(entry.colors) ? entry.colors : entry;
  return {
    id: newPreferenceId('scheme'),
    name,
    colors: opaqueSchemeColors(
      {
        ...colors,
        // Windows Terminal says purple and cursorColor where xterm says
        // magenta and cursor.
        magenta: colors.magenta ?? colors.purple,
        brightMagenta: colors.brightMagenta ?? colors.brightPurple,
        cursor: colors.cursor ?? colors.cursorColor,
      },
      name,
    ),
  };
}

const ITERM_COLOR_NAMES: Record<CustomSchemeColorKey, string> = {
  background: 'Background Color',
  foreground: 'Foreground Color',
  cursor: 'Cursor Color',
  selectionBackground: 'Selection Color',
  black: 'Ansi 0 Color',
  red: 'Ansi 1 Color',
  green: 'Ansi 2 Color',
  yellow: 'Ansi 3 Color',
  blue: 'Ansi 4 Color',
  magenta: 'Ansi 5 Color',
  cyan: 'Ansi 6 Color',
  white: 'Ansi 7 Color',
  brightBlack: 'Ansi 8 Color',
  brightRed: 'Ansi 9 Color',
  brightGreen: 'Ansi 10 Color',
  brightYellow: 'Ansi 11 Color',
  brightBlue: 'Ansi 12 Color',
  brightMagenta: 'Ansi 13 Color',
  brightCyan: 'Ansi 14 Color',
  brightWhite: 'Ansi 15 Color',
};

const ITERM_COLOR_RE = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
const ITERM_COMPONENT_RE =
  /<key>(Red|Green|Blue|Alpha) Component<\/key>\s*<(?:real|integer)>([^<]*)</g;

/**
 * An iTerm2 preset is a property list of named colors, each a flat dictionary
 * of 0–1 components. The export is machine-written and this regular, so the
 * colors are picked out directly; the untrusted file, which always carries a
 * DOCTYPE, never reaches an XML parser.
 */
function parseItermColors(text: string, name: string): CustomTerminalScheme {
  if (!/<plist[\s>]/.test(text)) {
    throw new Error('This file is neither a JSON color scheme nor an iTerm2 color preset.');
  }
  const colorsByName = new Map<string, string>();
  for (const [, colorName, dictionary] of text.matchAll(ITERM_COLOR_RE)) {
    const components = new Map<string, number>();
    for (const [, component, value] of dictionary!.matchAll(ITERM_COMPONENT_RE)) {
      components.set(component!, Number(value));
    }
    const channels = ['Red', 'Green', 'Blue'].map((channel) => components.get(channel));
    if (channels.some((channel) => channel === undefined || !Number.isFinite(channel))) continue;
    const alpha = components.get('Alpha') ?? 1;
    colorsByName.set(
      colorName!.trim(),
      `#${[...channels, Number.isFinite(alpha) ? alpha : 1]
        .map((channel) =>
          Math.round(Math.min(1, Math.max(0, channel!)) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`,
    );
  }
  const source: Partial<Record<CustomSchemeColorKey, string>> = {};
  for (const key of SCHEME_COLOR_KEYS) source[key] = colorsByName.get(ITERM_COLOR_NAMES[key]);
  return { id: newPreferenceId('scheme'), name, colors: opaqueSchemeColors(source, name) };
}

const SCHEME_COLOR_LABELS: Partial<Record<CustomSchemeColorKey, string>> = {
  foreground: 'foreground',
  background: 'background',
  magenta: 'magenta (or purple)',
  brightMagenta: 'brightMagenta (or brightPurple)',
};

/**
 * Normalize a full palette, in any notation a scheme file or a built-in theme
 * uses, to opaque `#rrggbb`. A translucent color is flattened over the
 * background — the built-in selections are translucent, and that is the color
 * the terminal paints. The cursor and the selection are optional in most
 * formats and derive from the text color when a scheme leaves them out.
 */
function opaqueSchemeColors(
  source: Partial<Record<CustomSchemeColorKey, unknown>>,
  schemeName: string,
): CustomSchemeColors {
  const required = (key: CustomSchemeColorKey): Rgba => {
    const color = parseColor(source[key]);
    if (!color) {
      throw new Error(
        `${schemeName}: the color "${SCHEME_COLOR_LABELS[key] ?? key}" is missing or is not a color such as "#1e1e2e".`,
      );
    }
    return color;
  };
  const background = { ...required('background'), a: 1 };
  const foreground = flatten(required('foreground'), background);
  const colors = {
    background: toHex(background),
    foreground: toHex(foreground),
    cursor: toHex(flatten(parseColor(source.cursor) ?? foreground, background)),
    selectionBackground: toHex(
      flatten(parseColor(source.selectionBackground) ?? { ...foreground, a: 0.3 }, background),
    ),
  } as CustomSchemeColors;
  for (const key of [...SCHEME_ANSI_COLOR_KEYS, ...SCHEME_BRIGHT_ANSI_COLOR_KEYS]) {
    colors[key] = toHex(flatten(required(key), background));
  }
  return colors;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX_NOTATION_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_NOTATION_RE =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i;

function parseColor(value: unknown): Rgba | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const hex = HEX_NOTATION_RE.exec(text)?.[1];
  if (hex) {
    const digits = hex.length === 3 ? hex.replace(/./g, '$&$&') : hex;
    const channel = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16);
    return {
      r: channel(0),
      g: channel(2),
      b: channel(4),
      a: digits.length === 8 ? channel(6) / 255 : 1,
    };
  }
  const rgb = RGB_NOTATION_RE.exec(text);
  if (!rgb) return undefined;
  const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as [number, number, number];
  if (r > 255 || g > 255 || b > 255) return undefined;
  return { r, g, b, a: rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4])) };
}

function flatten(color: Rgba, backdrop: Rgba): Rgba {
  if (color.a >= 1) return color;
  const mix = (top: number, bottom: number) => Math.round(top * color.a + bottom * (1 - color.a));
  return {
    r: mix(color.r, backdrop.r),
    g: mix(color.g, backdrop.g),
    b: mix(color.b, backdrop.b),
    a: 1,
  };
}

function toHex({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** Whether black text reads better than white on this `#rrggbb` background. */
function isLightColor(color: string): boolean {
  const [red, green, blue] = [1, 3, 5]
    .map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    ) as [number, number, number];
  // The WCAG relative luminance at which both contrast ratios are equal.
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.179;
}

function unusedSchemeName(name: string, existing: readonly CustomTerminalScheme[]): string {
  const taken = new Set(
    [...TERMINAL_SCHEMES, ...existing].map((scheme) => scheme.name.toLocaleLowerCase()),
  );
  if (!taken.has(name.toLocaleLowerCase())) return name;
  let suffix = 2;
  while (taken.has(`${name} ${suffix}`.toLocaleLowerCase())) suffix++;
  return `${name} ${suffix}`;
}

function derivedSchemeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().slice(0, MAX_DERIVED_NAME_LENGTH).trim() || undefined;
}

function schemeNameFromFilename(filename: string): string {
  return derivedSchemeName(filename.replace(/\.[^.]*$/, '')) ?? 'Imported scheme';
}

/** Strip unknown JSON fields instead of carrying them into preferences and later exports. */
function copyScheme(scheme: CustomTerminalScheme): CustomTerminalScheme {
  const colors = {} as CustomSchemeColors;
  for (const key of SCHEME_COLOR_KEYS) colors[key] = scheme.colors[key].toLowerCase();
  return { id: scheme.id, name: scheme.name, colors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
