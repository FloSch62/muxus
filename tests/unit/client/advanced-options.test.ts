import { describe, expect, it } from 'vitest';
import { DIAL_TIME_KEYWORDS } from '@muxus/shared';
import {
  LEGACY_ALGORITHM_PRESET,
  unsupportedEntries,
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

describe('legacy algorithm preset', () => {
  it('only uses append forms and dial-time keywords', () => {
    for (const row of LEGACY_ALGORITHM_PRESET) {
      expect(row.value.startsWith('+')).toBe(true);
      expect(DIAL_TIME_KEYWORDS.has(row.keyword.toLowerCase())).toBe(true);
    }
  });
});
