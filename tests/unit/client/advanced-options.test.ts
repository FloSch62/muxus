import { describe, expect, it } from 'vitest';
import { DIAL_TIME_KEYWORDS } from '@muxus/shared';
import {
  applyLegacyPreset,
  LEGACY_ALGORITHM_PRESET,
  legacyPresetState,
  optionValue,
  unsupportedEntries,
  withOptionValue,
} from '../../../client/src/components/host-editor/advanced-options.js';

const TABLES = {
  Ciphers: ['aes128-cbc', 'aes256-ctr', 'chacha20-poly1305@openssh.com'],
  KexAlgorithms: ['curve25519-sha256', 'diffie-hellman-group14-sha1'],
};

describe('unsupportedEntries', () => {
  it('flags entries the SSH engine cannot offer, keeping prefix and case out of it', () => {
    expect(unsupportedEntries('ciphers', '+AES128-CBC,serpent-cbc', TABLES)).toEqual(['serpent-cbc']);
    expect(unsupportedEntries('KexAlgorithms', 'sntrup761x25519-sha512@openssh.com', TABLES)).toEqual([
      'sntrup761x25519-sha512@openssh.com',
    ]);
  });

  it('skips wildcard patterns, unknown keywords and missing tables', () => {
    expect(unsupportedEntries('Ciphers', '-*cbc', TABLES)).toEqual([]);
    expect(unsupportedEntries('Compression', 'yes', TABLES)).toEqual([]);
    expect(unsupportedEntries('Ciphers', 'serpent-cbc', undefined)).toEqual([]);
  });
});

describe('one option as a field', () => {
  const extras = [
    { keyword: 'Compression', value: 'yes' },
    { keyword: 'kexalgorithms', value: '+diffie-hellman-group14-sha1' },
    { keyword: 'KexAlgorithms', value: '+diffie-hellman-group1-sha1' },
  ];

  it('reads the first row of a keyword, whatever its case, as ssh_config does', () => {
    expect(optionValue(extras, 'KexAlgorithms')).toBe('+diffie-hellman-group14-sha1');
    expect(optionValue(extras, 'Ciphers')).toBe('');
  });

  it('keeps one row per keyword where the first one was, and drops it when blank', () => {
    expect(withOptionValue(extras, 'KexAlgorithms', '^ecdh-sha2-nistp256')).toEqual([
      { keyword: 'Compression', value: 'yes' },
      { keyword: 'KexAlgorithms', value: '^ecdh-sha2-nistp256' },
    ]);
    expect(withOptionValue(extras, 'Ciphers', '+aes128-cbc')).toEqual([
      ...extras,
      { keyword: 'Ciphers', value: '+aes128-cbc' },
    ]);
    expect(withOptionValue(extras, 'KexAlgorithms', ' ')).toEqual([{ keyword: 'Compression', value: 'yes' }]);
  });
});

describe('legacy algorithm preset', () => {
  it('only uses append forms and dial-time keywords', () => {
    for (const row of LEGACY_ALGORITHM_PRESET) {
      expect(row.value.startsWith('+')).toBe(true);
      expect(DIAL_TIME_KEYWORDS.has(row.keyword.toLowerCase())).toBe(true);
    }
  });

  it('adds the preset to a host using modern defaults', () => {
    const extras = [{ keyword: 'Compression', value: 'yes' }];
    const next = applyLegacyPreset(extras);
    expect(legacyPresetState(extras)).toBe('missing');
    expect(legacyPresetState(next)).toBe('enabled');
    expect(next[0]).toEqual(extras[0]);
    expect(next.slice(1)).toEqual(LEGACY_ALGORITHM_PRESET);
  });

  it('completes existing append and exact policies without replacing them', () => {
    const extras = [
      { keyword: 'KexAlgorithms', value: '+curve25519-sha256' },
      { keyword: 'HostKeyAlgorithms', value: 'ssh-ed25519' },
    ];
    const next = applyLegacyPreset(extras);
    expect(legacyPresetState(extras)).toBe('partial');
    expect(next[0]!.value).toContain('+curve25519-sha256,');
    expect(next[0]!.value).toContain('diffie-hellman-group14-sha1');
    expect(next[0]!.value.endsWith(',diffie-hellman-group1-sha1')).toBe(true);
    expect(next[1]!.value).toBe('ssh-ed25519,ssh-rsa');
    expect(legacyPresetState(next)).toBe('enabled');
  });

  it('leaves removal policies untouched for manual review', () => {
    const extras = [{ keyword: 'Ciphers', value: '-*cbc' }];
    expect(legacyPresetState(extras)).toBe('conflict');
    expect(applyLegacyPreset(extras).find((row) => row.keyword === 'Ciphers')).toEqual(extras[0]);
  });
});
