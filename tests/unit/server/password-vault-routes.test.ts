import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../../server/src/app.js';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { sshPasswordAccount } from '../../../server/src/security/password-vault.js';

const TOKEN = 'password-vault-route-token';
const MASTER = 'master-8';
const REMOTE_PASSWORD = 'remote-password';
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: AppContext;

beforeEach(async () => {
  ({ app, ctx } = await buildApp(
    resolveConfig({
      token: TOKEN,
      databasePath: ':memory:',
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }),
  ));
});

afterEach(async () => {
  await app.close();
});

function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}

describe('password vault routes', () => {
  it('creates an automatic vault and gates reveal and edit with the master password', async () => {
    const initial = await app.inject({
      method: 'GET',
      url: '/api/password-vault',
      headers: auth(),
    });
    expect(initial.json()).toMatchObject({
      configured: false,
      automaticAccess: false,
      credentialCount: 0,
    });

    const short = await app.inject({
      method: 'POST',
      url: '/api/password-vault/create',
      headers: auth(),
      payload: { password: '1234567' },
    });
    expect(short.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/password-vault/create',
      headers: auth(),
      payload: { password: MASTER },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      configured: true,
      automaticAccess: true,
    });

    const account = sshPasswordAccount({
      user: 'alice',
      host: 'router.example',
      port: 22,
    });
    ctx.vault.rememberSshPassword(
      account,
      'alice@router.example:22',
      REMOTE_PASSWORD,
    );
    const [credential] = ctx.vault.status().credentials;
    expect(credential).toBeDefined();

    const wrongReveal = await app.inject({
      method: 'POST',
      url: `/api/password-vault/credentials/${credential!.id}/reveal`,
      headers: auth(),
      payload: { masterPassword: 'incorrect' },
    });
    expect(wrongReveal.statusCode).toBe(401);
    expect(wrongReveal.json().code).toBe('invalid-master-password');

    const revealed = await app.inject({
      method: 'POST',
      url: `/api/password-vault/credentials/${credential!.id}/reveal`,
      headers: auth(),
      payload: { masterPassword: MASTER },
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.headers['cache-control']).toBe('no-store');
    expect(revealed.json()).toEqual({ password: REMOTE_PASSWORD });

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/password-vault/credentials/${credential!.id}`,
      headers: auth(),
      payload: {
        masterPassword: MASTER,
        password: 'changed-password',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(ctx.vault.sshPassword(account)).toBe('changed-password');

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/password-vault',
      headers: auth(),
    });
    expect(deleted.json()).toMatchObject({
      configured: false,
      automaticAccess: false,
      credentialCount: 0,
    });
  }, 15_000);
});
