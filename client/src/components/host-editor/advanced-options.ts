/**
 * The algorithm lines an old console server or switch typically needs —
 * append forms, so modern hosts matched by the same block keep working.
 */
export const LEGACY_ALGORITHM_PRESET = [
  { keyword: 'KexAlgorithms', value: '+diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1' },
  { keyword: 'HostKeyAlgorithms', value: '+ssh-rsa' },
  { keyword: 'Ciphers', value: '+aes256-cbc,aes192-cbc,aes128-cbc,3des-cbc' },
];

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
