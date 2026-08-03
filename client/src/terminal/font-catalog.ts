export const BUNDLED_TERMINAL_FONT_FAMILIES = ['JetBrains Mono'] as const;
export const GENERIC_TERMINAL_FONT_FAMILIES = ['monospace'] as const;

const CSS_GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

const MAX_FONT_FAMILY_LENGTH = 200;

function normalizedFamily(family: string): string {
  let value = family.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.toLowerCase();
}

function isCssGenericFamily(family: string): boolean {
  const trimmed = family.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return false;
  }
  return CSS_GENERIC_FONT_FAMILIES.has(trimmed.toLowerCase());
}

/** Bundled, installed and generic terminal fonts without case-only duplicates. */
export function terminalFontFamilies(installed: readonly string[] = []): string[] {
  const families = new Map<string, string>();
  const add = (family: string) => {
    const trimmed = family.trim();
    if (!trimmed || trimmed.length > MAX_FONT_FAMILY_LENGTH) return;
    families.set(normalizedFamily(trimmed), trimmed);
  };

  for (const family of BUNDLED_TERMINAL_FONT_FAMILIES) add(family);
  for (const family of [...installed].sort((left, right) => left.localeCompare(right))) {
    if (!families.has(normalizedFamily(family))) add(family);
  }
  for (const family of GENERIC_TERMINAL_FONT_FAMILIES) add(family);
  return [...families.values()];
}

/** Undefined means the browser could not enumerate local fonts. */
export function terminalFontIsAvailable(
  family: string,
  installed: readonly string[] | undefined,
): boolean | undefined {
  const selected = normalizedFamily(family);
  if (!selected) return true;
  if (
    BUNDLED_TERMINAL_FONT_FAMILIES.some(
      (candidate) => normalizedFamily(candidate) === selected,
    ) || isCssGenericFamily(family)
  ) {
    return true;
  }
  if (installed === undefined) return undefined;
  return installed.some((candidate) => normalizedFamily(candidate) === selected);
}

/** Read the host font catalog through Electron's isolated preload bridge. */
export function readInstalledTerminalFontFamilies(): Promise<string[] | undefined> {
  return window.muxusDesktop?.listLocalFontFamilies?.() ?? Promise.resolve(undefined);
}
