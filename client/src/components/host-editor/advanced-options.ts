/**
 * The algorithm lines an old console server or switch typically needs —
 * append forms, so modern hosts matched by the same block keep working.
 */
export const LEGACY_ALGORITHM_PRESET = [
  { keyword: 'KexAlgorithms', value: '+diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1' },
  { keyword: 'HostKeyAlgorithms', value: '+ssh-rsa' },
  { keyword: 'Ciphers', value: '+aes256-cbc,aes192-cbc,aes128-cbc,3des-cbc' },
] as const;

type ExtraOption = { keyword: string; value: string };

export type LegacyPresetState = 'missing' | 'partial' | 'enabled' | 'conflict';

/** Whether the raw algorithm rows already provide the legacy-device preset. */
export function legacyPresetState(extras: readonly ExtraOption[]): LegacyPresetState {
  let configured = 0;
  let required = 0;
  let customPolicy = false;
  let conflict = false;

  for (const preset of LEGACY_ALGORITHM_PRESET) {
    const row = extras.find(
      (extra) => extra.keyword.trim().toLowerCase() === preset.keyword.toLowerCase(),
    );
    const requiredNames = algorithmNames(preset.value);
    required += requiredNames.length;
    if (!row) continue;
    customPolicy = true;
    if (row.value.trim().startsWith('-')) {
      conflict = true;
      continue;
    }
    const current = new Set(algorithmNames(row.value));
    configured += requiredNames.filter((name) => current.has(name)).length;
  }

  if (configured === required) return 'enabled';
  if (conflict) return 'conflict';
  return configured > 0 || customPolicy ? 'partial' : 'missing';
}

/**
 * Add the legacy names without replacing a user's existing exact, append, or
 * prepend policy. Removal policies are left untouched because rewriting one
 * would silently discard the user's exclusions.
 */
export function applyLegacyPreset(extras: readonly ExtraOption[]): ExtraOption[] {
  const next = extras.map((extra) => ({ ...extra }));
  for (const preset of LEGACY_ALGORITHM_PRESET) {
    const index = next.findIndex(
      (extra) => extra.keyword.trim().toLowerCase() === preset.keyword.toLowerCase(),
    );
    if (index < 0) {
      next.push({ ...preset });
      continue;
    }
    const row = next[index]!;
    const value = row.value.trim();
    if (value.startsWith('-')) continue;
    const prefix = /^[+^]/.test(value) ? value[0]! : '';
    const currentNames = algorithmNames(value);
    const seen = new Set(currentNames);
    const missing = algorithmNames(preset.value).filter((name) => !seen.has(name));
    if (!missing.length) continue;
    next[index] = {
      ...row,
      value: currentNames.length
        ? `${prefix}${[...currentNames, ...missing].join(',')}`
        : preset.value,
    };
  }
  return next;
}

/**
 * Entries of an algorithm-list option the dialer would have to skip: not
 * `*`/`?` patterns, and absent from the SSH engine's supported table for the
 * keyword. Non-algorithm keywords and a missing table return [].
 */
export function unsupportedEntries(
  keyword: string,
  value: string,
  tables: Record<string, string[]> | undefined,
): string[] {
  if (!tables) return [];
  const canonical = Object.keys(tables).find((k) => k.toLowerCase() === keyword.trim().toLowerCase());
  if (!canonical) return [];
  const supported = tables[canonical]!;
  return value
    .replace(/^[+^-]/, '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry) => !/[*?]/.test(entry) && !supported.includes(entry));
}

function algorithmNames(value: string): string[] {
  return value
    .trim()
    .replace(/^[+^-]/, '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}
