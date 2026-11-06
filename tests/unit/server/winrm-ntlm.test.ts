import { describe, expect, it } from 'vitest';
import {
  authenticateMessage,
  md4,
  negotiateMessage,
  NtlmSession,
  ntowfv2,
  parseChallenge,
  Rc4,
  splitUser,
} from '../../../server/src/winrm/ntlm.js';

const hex = (value: string) => Buffer.from(value.replace(/\s+/g, ''), 'hex');

describe('MD4 and RC4', () => {
  it('match the RFC 1320 examples', () => {
    expect(md4(Buffer.alloc(0)).toString('hex')).toBe('31d6cfe0d16ae931b73c59d7e0c089c0');
    expect(md4(Buffer.from('abc')).toString('hex')).toBe('a448017aaf21d8525fc10ae87aa6729d');
    expect(
      md4(Buffer.from('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toString('hex'),
    ).toBe('e33b4ddc9c38f2199c3e7b164fcc0536');
    // The NT hash of "Password" (MS-NLMP 4.2.2.1.2).
    expect(md4(Buffer.from('Password', 'utf16le')).toString('hex')).toBe('a4f49c406510bdcab6824ee7c30fd852');
  });

  it('matches the classic RC4 example and keeps its state between calls', () => {
    expect(new Rc4(Buffer.from('Key')).update(Buffer.from('Plaintext')).toString('hex')).toBe('bbf316e8d940af0ad3');
    const split = new Rc4(Buffer.from('Key'));
    expect(Buffer.concat([split.update(Buffer.from('Plain')), split.update(Buffer.from('text'))]).toString('hex')).toBe(
      'bbf316e8d940af0ad3',
    );
  });
});

describe('NTLMv2 (MS-NLMP 4.2.4)', () => {
  const targetInfo = hex(
    '02000c0044006f006d00610069006e00 01000c005300650072007600650072000000 0000'.replace(/ /g, ''),
  );
  const challenge = {
    flags: 0xe28a8233,
    serverChallenge: hex('0123456789abcdef'),
    targetInfo,
  };

  it('derives the keys of the published example', () => {
    expect(ntowfv2('Password', 'User', 'Domain').toString('hex')).toBe('0c868a403bfd7a93a3001ef22ef02e3f');
    const result = authenticateMessage({
      username: 'Domain\\User',
      password: 'Password',
      workstation: 'COMPUTER',
      challenge,
      clientChallenge: hex('aaaaaaaaaaaaaaaa'),
      timestamp: Buffer.alloc(8),
      exportedSessionKey: hex('55555555555555555555555555555555'),
    });
    expect(result.ntProofStr.toString('hex')).toBe('68cd0ab851e51c96aabc927bebef6a1c');
    expect(result.sessionBaseKey.toString('hex')).toBe('8de40ccadbc14a82f15cb0ad0de95ca3');
    expect(result.encryptedRandomSessionKey.toString('hex')).toBe('c5dad2544fc9799094ce1ce90bc9d03e');
  });

  it('seals and signs like the published example', () => {
    const session = new NtlmSession(hex('55555555555555555555555555555555'), 0xe28a8233);
    const { sealed, signature } = session.seal(Buffer.from('Plaintext', 'utf16le'));
    expect(sealed.toString('hex')).toBe('54e50165bf1936dc996020c1811b0f06fb5f');
    expect(signature.toString('hex')).toBe('010000007fb38ec5c55d497600000000');
  });

  it('round-trips messages between two ends with mirrored keys', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const client = new NtlmSession(key, 0xe28a8233);
    // The server's view: what the client seals, the server unseals with its
    // client-to-server key. Checked here by sealing as the server would.
    const server = new NtlmSession(key, 0xe28a8233) as unknown as {
      clientSeal: Rc4;
      serverSeal: Rc4;
      clientSign: Buffer;
      serverSign: Buffer;
      seal(message: Buffer): { sealed: Buffer; signature: Buffer };
    };
    [server.clientSeal, server.serverSeal] = [server.serverSeal, server.clientSeal];
    [server.clientSign, server.serverSign] = [server.serverSign, server.clientSign];
    for (const text of ['first', 'second message', 'third']) {
      const { sealed, signature } = server.seal(Buffer.from(text));
      expect(client.unseal(sealed, signature).toString()).toBe(text);
    }
    const tampered = server.seal(Buffer.from('fourth'));
    tampered.signature.writeUInt8(tampered.signature.readUInt8(5) ^ 1, 5);
    expect(() => client.unseal(tampered.sealed, tampered.signature)).toThrow(/signature/);
  });
});

describe('NTLM messages', () => {
  it('builds a negotiate message and reads a challenge', () => {
    const negotiate = negotiateMessage();
    expect(negotiate.subarray(0, 8).toString('latin1')).toBe('NTLMSSP\0');
    expect(negotiate.readUInt32LE(8)).toBe(1);

    const info = Buffer.from([7, 0, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0]);
    const challenge = Buffer.alloc(56 + info.length);
    challenge.write('NTLMSSP\0', 0, 'latin1');
    challenge.writeUInt32LE(2, 8);
    challenge.writeUInt32LE(0xe28a8235, 20);
    Buffer.from('0123456789abcdef', 'hex').copy(challenge, 24);
    challenge.writeUInt16LE(info.length, 40);
    challenge.writeUInt16LE(info.length, 42);
    challenge.writeUInt32LE(56, 44);
    info.copy(challenge, 56);
    const parsed = parseChallenge(challenge);
    expect(parsed.serverChallenge.toString('hex')).toBe('0123456789abcdef');
    expect(parsed.targetInfo).toEqual(info);

    // A server timestamp is reused and the LM response is zeroes.
    const auth = authenticateMessage({ username: 'u', password: 'p', challenge: parsed });
    const lmLength = auth.message.readUInt16LE(12);
    const lmOffset = auth.message.readUInt32LE(16);
    expect(auth.message.subarray(lmOffset, lmOffset + lmLength)).toEqual(Buffer.alloc(24));
  });

  it('splits DOMAIN\\user and keeps a UPN whole', () => {
    expect(splitUser('CORP\\alice')).toEqual({ domain: 'CORP', user: 'alice' });
    expect(splitUser('alice@corp.example')).toEqual({ domain: '', user: 'alice@corp.example' });
  });
});
