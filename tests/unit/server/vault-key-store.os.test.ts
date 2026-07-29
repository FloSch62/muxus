import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemVaultKeyStore } from '../../../server/src/security/vault-key-store.js';

// Round-trips a key through the real OS credential store (Windows Credential
// Manager, macOS Keychain, or a Secret Service keyring). Opt-in because it
// needs an unlocked keyring, which headless environments often lack.
const enabled = process.env.MUXUS_OS_KEYRING_SMOKE === '1';

describe.runIf(enabled)('SystemVaultKeyStore (OS credential store)', () => {
  const store = new SystemVaultKeyStore();
  const vaultId = `os-smoke-${randomBytes(8).toString('hex')}`;

  afterEach(async () => {
    await store.delete(vaultId).catch(() => undefined);
  });

  it('reports a missing key as undefined', async () => {
    expect(await store.get(vaultId)).toBeUndefined();
  });

  it('round-trips a 32-byte key and deletes it', async () => {
    const key = randomBytes(32);
    await store.set(vaultId, key);
    const loaded = await store.get(vaultId);
    expect(loaded?.toString('hex')).toBe(key.toString('hex'));

    await store.delete(vaultId);
    expect(await store.get(vaultId)).toBeUndefined();
  });

  it('overwrites an existing key in place', async () => {
    await store.set(vaultId, randomBytes(32));
    const replacement = randomBytes(32);
    await store.set(vaultId, replacement);
    const loaded = await store.get(vaultId);
    expect(loaded?.toString('hex')).toBe(replacement.toString('hex'));
  });
});
