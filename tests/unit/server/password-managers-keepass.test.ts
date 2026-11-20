import { copyFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { KeePassProvider } from '../../../server/src/password-managers/keepass.js';
import { PasswordManagerError } from '../../../server/src/password-managers/provider.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** KDBX 3.1 (AES-KDF), written by KeePassXC 2.7.6. */
const KEEPASSXC = path.join(fixtures, 'keepassxc-kdbx3.kdbx');
/** KDBX 4 (Argon2id), checked to open in KeePassXC 2.7.6. */
const KDBX4 = path.join(fixtures, 'kdbx4-argon2id.kdbx');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-keepass-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function problemOf(action: Promise<unknown>): Promise<string | undefined> {
  try {
    await action;
    return undefined;
  } catch (err) {
    return err instanceof PasswordManagerError ? err.problem : `unexpected: ${String(err)}`;
  }
}

describe('KeePass databases', () => {
  it('reads a database written by KeePassXC', async () => {
    const provider = new KeePassProvider({ path: KEEPASSXC });
    expect(await provider.status()).toMatchObject({ state: 'locked' });
    await provider.unlock('master-pw-1');
    expect(await provider.status()).toEqual({ state: 'ready' });

    const entries = await provider.entries();
    expect(entries.map(({ title, username, url, group }) => ({ title, username, url, group }))).toEqual([
      { title: 'Core router', username: 'admin', url: undefined, group: undefined },
      { title: 'web1', username: 'root', url: 'ssh://web1.example.com', group: 'Servers' },
    ]);
    const web1 = entries.find((entry) => entry.title === 'web1')!;
    expect(await provider.password(web1.id)).toBe('hunter2-säcret');
  });

  it('reads a KDBX 4 database protected with Argon2id', async () => {
    const provider = new KeePassProvider({ path: KDBX4 });
    await provider.unlock('kdbx4-master');
    const entries = await provider.entries();
    // The recycle bin and the entry without a password are left out.
    expect(entries.map((entry) => [entry.group, entry.title, entry.username])).toEqual([
      ['Lab', 'sw2 (same login)', 'netops'],
      ['Lab / Core', 'sw1', 'netops'],
    ]);
    const [sw2, sw1] = entries;
    expect(await provider.password(sw1!.id)).toBe('p4ss "quoted" & ünïcode');
    // A field reference resolves to the entry it points at.
    expect(await provider.password(sw2!.id)).toBe('p4ss "quoted" & ünïcode');
  });

  it('rejects a wrong password and stays locked', async () => {
    const provider = new KeePassProvider({ path: KDBX4 });
    expect(await problemOf(provider.unlock('not-the-password'))).toBe('invalid-unlock');
    expect(await problemOf(provider.entries())).toBe('locked');
    expect(await provider.status()).toMatchObject({ state: 'locked' });
  });

  it('locks again on request', async () => {
    const provider = new KeePassProvider({ path: KDBX4 });
    await provider.unlock('kdbx4-master');
    await provider.lock();
    expect(await problemOf(provider.password('J/3PdeqpbaiDMsRLdzIWyA=='))).toBe('locked');
  });

  it('reports an entry that is gone and a file that is missing or not a database', async () => {
    const provider = new KeePassProvider({ path: KDBX4 });
    await provider.unlock('kdbx4-master');
    expect(await problemOf(provider.password('AAAAAAAAAAAAAAAAAAAAAA=='))).toBe('entry-missing');

    const missing = new KeePassProvider({ path: path.join(tmp, 'nowhere.kdbx') });
    expect(await missing.status()).toMatchObject({ state: 'unavailable' });
    expect(await problemOf(missing.unlock('x'))).toBe('unavailable');

    const text = path.join(tmp, 'notes.kdbx');
    writeFileSync(text, 'just some text, long enough to have a header to misread');
    expect(await problemOf(new KeePassProvider({ path: text }).unlock('x'))).toBe('failed');
  });

  it('picks up a database saved again by KeePass without asking for the password', async () => {
    const file = path.join(tmp, 'live.kdbx');
    copyFileSync(KEEPASSXC, file);
    const provider = new KeePassProvider({ path: file });
    await provider.unlock('master-pw-1');
    expect(await provider.entries()).toHaveLength(2);

    // The same password still opens the replaced file...
    copyFileSync(KEEPASSXC, file);
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(await provider.entries()).toHaveLength(2);

    // ...but a database whose password changed has to be unlocked again.
    copyFileSync(KDBX4, file);
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect(await problemOf(provider.entries())).toBe('locked');
    expect(await provider.status()).toMatchObject({ state: 'locked' });
  });
});
