import { describe, expect, it } from 'vitest';
import {
  connectionAlgorithms,
  hostKeyAlgorithmsPreferring,
  supportedAlgorithms,
} from '../../../server/src/ssh/algorithms.js';
import { algorithmSupport } from '../../../server/src/ssh/engine.js';

// What the engine offers when the config says nothing.
const DEFAULTS = algorithmSupport();

describe('connectionAlgorithms', () => {
  it('returns no override when the config sets nothing', () => {
    expect(connectionAlgorithms({})).toEqual({ algorithms: undefined, notes: [] });
  });

  it('maps a bare list to exactly that list, order preserved', () => {
    const { algorithms, notes } = connectionAlgorithms({ ciphers: 'aes128-cbc,aes256-ctr' });
    expect(algorithms).toEqual({ cipher: ['aes128-cbc', 'aes256-ctr'] });
    expect(notes).toEqual([]);
  });

  it('applies +/^/- prefixes to the defaults', () => {
    const { algorithms } = connectionAlgorithms({
      kexAlgorithms: '+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1',
      hostKeyAlgorithms: '^ssh-rsa',
      macs: '-hmac-sha1',
    });
    expect(algorithms).toEqual({
      kex: [...DEFAULTS.kex.defaults, 'diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1'],
      // `^` moves an algorithm that is already offered to the head, as in OpenSSH.
      hostKey: ['ssh-rsa', ...DEFAULTS.hostKey.defaults.filter((name) => name !== 'ssh-rsa')],
      mac: DEFAULTS.mac.defaults.filter((name) => name !== 'hmac-sha1'),
    });
  });

  it('expands wildcard patterns against the supported table', () => {
    const { algorithms } = connectionAlgorithms({ ciphers: '+*cbc' });
    expect(algorithms).toEqual({
      cipher: [...DEFAULTS.cipher.defaults, 'aes256-cbc', 'aes192-cbc', 'aes128-cbc', '3des-cbc'],
    });
    expect(connectionAlgorithms({ ciphers: '-*ctr' }).algorithms).toEqual({
      cipher: DEFAULTS.cipher.defaults.filter((name) => !name.endsWith('-ctr')),
    });
  });

  it('drops entries the engine does not implement and reports them', () => {
    const { algorithms, notes } = connectionAlgorithms({
      kexAlgorithms: '+sntrup761x25519-sha512@openssh.com,diffie-hellman-group14-sha1',
    });
    expect(algorithms).toEqual({ kex: [...DEFAULTS.kex.defaults, 'diffie-hellman-group14-sha1'] });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('KexAlgorithms');
    expect(notes[0]).toContain('sntrup761x25519-sha512@openssh.com');
  });

  it('omits the category when nothing supported remains to append', () => {
    const { algorithms, notes } = connectionAlgorithms({
      kexAlgorithms: '+sntrup761x25519-sha512@openssh.com',
    });
    expect(algorithms).toBeUndefined();
    expect(notes).toHaveLength(1);
  });

  it('omits the category when a list changes nothing about the defaults', () => {
    expect(connectionAlgorithms({ kexAlgorithms: '+curve25519-sha256' })).toEqual({ algorithms: undefined, notes: [] });
    // Nothing ending in cbc is offered unless a host asks for it.
    expect(connectionAlgorithms({ ciphers: '-*cbc' })).toEqual({ algorithms: undefined, notes: [] });
  });

  it('silently ignores removals of algorithms the engine never offers', () => {
    const { algorithms, notes } = connectionAlgorithms({ macs: '-umac-64@openssh.com' });
    expect(algorithms).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it('rejects an exact list with no supported entries', () => {
    expect(() => connectionAlgorithms({ ciphers: 'chacha8-poly1305' })).toThrow(/Ciphers/);
  });

  it('rejects a removal that leaves nothing to offer', () => {
    expect(() => connectionAlgorithms({ macs: '-*' })).toThrow(/MACs/);
  });

  it('maps Compression yes/no to a compression preference and leaves unset alone', () => {
    expect(connectionAlgorithms({ compression: true }).algorithms).toEqual({
      compression: ['zlib@openssh.com', 'zlib', 'none'],
    });
    expect(connectionAlgorithms({ compression: false }).algorithms).toEqual({ compression: ['none'] });
    expect(connectionAlgorithms({}).algorithms).toBeUndefined();
  });

  it('handles the legacy console-server recipe end to end', () => {
    const { algorithms, notes } = connectionAlgorithms({
      ciphers: 'aes128-cbc',
      kexAlgorithms: '+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1',
      hostKeyAlgorithms: '+ssh-dss',
    });
    expect(algorithms).toEqual({
      cipher: ['aes128-cbc'],
      kex: [...DEFAULTS.kex.defaults, 'diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1'],
      hostKey: [...DEFAULTS.hostKey.defaults, 'ssh-dss'],
    });
    expect(notes).toEqual([]);
  });
});

describe('the engine\'s algorithm tables', () => {
  it('keeps what old network gear needs within reach', () => {
    const supported = supportedAlgorithms();
    expect(supported.KexAlgorithms).toEqual(
      expect.arrayContaining(['diffie-hellman-group1-sha1', 'diffie-hellman-group14-sha1', 'ecdh-sha2-nistp256']),
    );
    expect(supported.Ciphers).toEqual(expect.arrayContaining(['aes128-cbc', '3des-cbc', 'aes256-ctr']));
    expect(supported.MACs).toEqual(expect.arrayContaining(['hmac-sha1', 'hmac-sha2-256']));
    expect(supported.HostKeyAlgorithms).toEqual(expect.arrayContaining(['ssh-rsa', 'ssh-dss', 'ssh-ed25519']));
  });

  it('offers ssh-dss only to a host that asks for it', () => {
    expect(DEFAULTS.hostKey.defaults).not.toContain('ssh-dss');
    expect(supportedAlgorithms().HostKeyAlgorithms).toContain('ssh-dss');
  });

  it('asks a pinned host for its key type first and keeps the usual order after it', () => {
    expect(hostKeyAlgorithmsPreferring('ecdsa-sha2-nistp256').split(',')).toEqual([
      'ecdsa-sha2-nistp256',
      ...DEFAULTS.hostKey.defaults.filter((name) => name !== 'ecdsa-sha2-nistp256'),
    ]);
    expect(hostKeyAlgorithmsPreferring('ssh-rsa').split(',').slice(0, 3)).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
    ]);
  });
});
