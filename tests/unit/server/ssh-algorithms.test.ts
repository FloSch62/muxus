import { describe, expect, it } from 'vitest';
import { connectionAlgorithms } from '../../../server/src/ssh/algorithms.js';

describe('connectionAlgorithms', () => {
  it('returns no override when the config sets nothing', () => {
    expect(connectionAlgorithms({})).toEqual({ algorithms: undefined, notes: [] });
  });

  it('maps a bare list to an exact ssh2 list, order preserved', () => {
    const { algorithms, notes } = connectionAlgorithms({ ciphers: 'aes128-cbc,aes256-ctr' });
    expect(algorithms).toEqual({ cipher: ['aes128-cbc', 'aes256-ctr'] });
    expect(notes).toEqual([]);
  });

  it('maps +/^/- prefixes to append/prepend/remove on the defaults', () => {
    const { algorithms } = connectionAlgorithms({
      kexAlgorithms: '+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1',
      hostKeyAlgorithms: '^ssh-ed25519',
      macs: '-hmac-md5',
    });
    expect(algorithms).toEqual({
      kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1'] },
      serverHostKey: { prepend: ['ssh-ed25519'] },
      hmac: { remove: ['hmac-md5'] },
    });
  });

  it('expands wildcard patterns against the supported table', () => {
    const { algorithms } = connectionAlgorithms({ ciphers: '-*cbc' });
    expect(algorithms).toEqual({
      cipher: { remove: ['aes256-cbc', 'aes192-cbc', 'aes128-cbc', '3des-cbc'] },
    });
  });

  it('drops entries ssh2 does not implement and reports them', () => {
    const { algorithms, notes } = connectionAlgorithms({
      kexAlgorithms: '+sntrup761x25519-sha512@openssh.com,diffie-hellman-group14-sha1',
    });
    expect(algorithms).toEqual({ kex: { append: ['diffie-hellman-group14-sha1'] } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('KexAlgorithms');
    expect(notes[0]).toContain('sntrup761x25519-sha512@openssh.com');
  });

  it('omits the category when nothing supported remains to append', () => {
    const { algorithms, notes } = connectionAlgorithms({ kexAlgorithms: '+mlkem768x25519-sha256' });
    expect(algorithms).toBeUndefined();
    expect(notes).toHaveLength(1);
  });

  it('silently ignores removals of algorithms ssh2 never offers', () => {
    const { algorithms, notes } = connectionAlgorithms({ macs: '-umac-64@openssh.com' });
    expect(algorithms).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it('rejects an exact list with no supported entries', () => {
    expect(() => connectionAlgorithms({ ciphers: 'chacha8-poly1305' })).toThrow(/Ciphers/);
  });

  it('maps Compression yes/no to a compress preference and leaves unset alone', () => {
    expect(connectionAlgorithms({ compression: true }).algorithms).toEqual({
      compress: ['zlib@openssh.com', 'zlib', 'none'],
    });
    expect(connectionAlgorithms({ compression: false }).algorithms).toEqual({ compress: ['none'] });
    expect(connectionAlgorithms({}).algorithms).toBeUndefined();
  });

  it('handles the legacy console-server recipe end to end', () => {
    const { algorithms, notes } = connectionAlgorithms({
      ciphers: 'aes128-cbc',
      kexAlgorithms: '+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1',
      hostKeyAlgorithms: '+ssh-rsa',
    });
    expect(algorithms).toEqual({
      cipher: ['aes128-cbc'],
      kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1'] },
      serverHostKey: { append: ['ssh-rsa'] },
    });
    expect(notes).toEqual([]);
  });
});
