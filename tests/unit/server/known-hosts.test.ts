import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KnownHostsStore, fingerprintSha256, hostKeyType } from '../../../server/src/ssh/known-hosts.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-knownhosts-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function freshFile(): string {
  return path.join(tmp, `known_hosts-${counter++}`);
}

/** Build a syntactically valid SSH key blob: uint32 length + type + random payload. */
function makeKey(type = 'ssh-ed25519'): Buffer {
  const name = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length, 0);
  return Buffer.concat([len, name, randomBytes(32)]);
}

function hashedEntry(host: string, key: Buffer): string {
  const salt = randomBytes(20);
  const mac = createHmac('sha1', salt).update(host).digest();
  return `|1|${salt.toString('base64')}|${mac.toString('base64')} ${hostKeyType(key)} ${key.toString('base64')}`;
}

const missing = path.join(tmp, 'no-global-file');

describe('KnownHostsStore', () => {
  it('reports unknown hosts, then ok after record (TOFU)', () => {
    const store = new KnownHostsStore(freshFile(), missing);
    const key = makeKey();
    expect(store.verify('example.com', 22, key)).toEqual({ state: 'unknown' });
    store.record('example.com', 22, key);
    expect(store.verify('example.com', 22, key)).toEqual({ state: 'ok' });
  });

  it('reads every configured user file but records into the first', () => {
    const primary = freshFile();
    const extra = freshFile();
    const key = makeKey();
    writeFileSync(extra, `readonly.example ${hostKeyType(key)} ${key.toString('base64')}\n`);
    const store = new KnownHostsStore([primary, extra], missing);
    expect(store.verify('readonly.example', 22, key)).toEqual({ state: 'ok' });
    store.record('new.example', 22, key);
    expect(readFileSync(primary, 'utf8')).toContain('new.example');
    expect(readFileSync(extra, 'utf8')).not.toContain('new.example');
  });

  it('UserKnownHostsFile none: nothing matches and record is a no-op', () => {
    const store = new KnownHostsStore([], missing);
    const key = makeKey();
    expect(store.verify('example.com', 22, key)).toEqual({ state: 'unknown' });
    expect(() => store.record('example.com', 22, key)).not.toThrow();
    expect(store.verify('example.com', 22, key)).toEqual({ state: 'unknown' });
  });

  it('UserKnownHostsFile set to the null device discards accepted keys', () => {
    const store = new KnownHostsStore(os.devNull, missing);
    const key = makeKey();
    expect(() => store.record('example.com', 22, key)).not.toThrow();
    expect(store.verify('example.com', 22, key)).toEqual({ state: 'unknown' });
  });

  it('stores non-22 ports in [host]:port notation', () => {
    const file = freshFile();
    const store = new KnownHostsStore(file, missing);
    const key = makeKey();
    store.record('example.com', 2222, key);
    expect(readFileSync(file, 'utf8')).toContain('[example.com]:2222 ssh-ed25519');
    expect(store.verify('example.com', 2222, key)).toEqual({ state: 'ok' });
    expect(store.verify('example.com', 22, key)).toEqual({ state: 'unknown' });
  });

  it('matches hashed and wildcard entries', () => {
    const file = freshFile();
    const key = makeKey();
    const key2 = makeKey('ssh-rsa');
    writeFileSync(file, `${hashedEntry('secret.example.com', key)}\n*.wild.example.com ${hostKeyType(key2)} ${key2.toString('base64')}\n`);
    const store = new KnownHostsStore(file, missing);
    expect(store.verify('secret.example.com', 22, key)).toEqual({ state: 'ok' });
    expect(store.verify('a.wild.example.com', 22, key2)).toEqual({ state: 'ok' });
  });

  it('flags a same-type key change with the previous fingerprint', () => {
    const file = freshFile();
    const store = new KnownHostsStore(file, missing);
    const oldKey = makeKey();
    store.record('example.com', 22, oldKey);
    const newKey = makeKey();
    expect(store.verify('example.com', 22, newKey)).toEqual({ state: 'changed', previous: fingerprintSha256(oldKey) });
    // A different key *type* is first contact, not a change.
    expect(store.verify('example.com', 22, makeKey('ssh-rsa'))).toEqual({ state: 'unknown' });
  });

  it('replaces stale entries on record like ssh-keygen -R, keeping a .old backup', () => {
    const file = freshFile();
    const store = new KnownHostsStore(file, missing);
    const oldKey = makeKey();
    const newKey = makeKey();
    store.record('example.com', 22, oldKey);
    store.record('example.com', 22, newKey);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(oldKey.toString('base64'));
    expect(text).toContain(newKey.toString('base64'));
    expect(readFileSync(`${file}.old`, 'utf8')).toContain(oldKey.toString('base64'));
    expect(store.verify('example.com', 22, newKey)).toEqual({ state: 'ok' });
  });

  it('honors @revoked markers', () => {
    const file = freshFile();
    const key = makeKey();
    writeFileSync(file, `@revoked example.com ${hostKeyType(key)} ${key.toString('base64')}\n`);
    const store = new KnownHostsStore(file, missing);
    expect(store.verify('example.com', 22, key)).toEqual({ state: 'revoked' });
  });

  it('consults the global file read-only', () => {
    const globalFile = freshFile();
    const key = makeKey();
    writeFileSync(globalFile, `corp.example.com ${hostKeyType(key)} ${key.toString('base64')}\n`);
    const store = new KnownHostsStore(freshFile(), globalFile);
    expect(store.verify('corp.example.com', 22, key)).toEqual({ state: 'ok' });
  });
});
