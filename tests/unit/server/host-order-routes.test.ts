import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'order-test-token';
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeEach(async () => {
  ({ app } = await buildApp(
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

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

describe('managed host order route', () => {
  it('persists one order across OpenSSH hosts and saved profiles', async () => {
    const create = await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        name: 'Core router',
        profile: { kind: 'telnet', host: 'router.example.test', port: 23 },
      },
    });
    expect(create.statusCode).toBe(200);
    const profileId = create.json().id as string;

    const order = await app.inject({
      method: 'PUT',
      url: '/api/hosts/order',
      headers: auth(),
      payload: {
        hosts: [
          { kind: 'profile', id: profileId },
          { kind: 'ssh', alias: 'web-prod' },
        ],
      },
    });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toEqual({ ok: true });

    const list = await app.inject({ method: 'GET', url: '/api/profiles', headers: auth() });
    expect(list.json().profiles[0].metadata.sortOrder).toBe(0);
  });

  it('rejects duplicates, unknown profiles, and unauthenticated requests', async () => {
    const duplicate = await app.inject({
      method: 'PUT',
      url: '/api/hosts/order',
      headers: auth(),
      payload: {
        hosts: [
          { kind: 'ssh', alias: 'same' },
          { kind: 'ssh', alias: 'same' },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().message).toMatch(/duplicate/);

    const missing = await app.inject({
      method: 'PUT',
      url: '/api/hosts/order',
      headers: auth(),
      payload: { hosts: [{ kind: 'profile', id: 'missing' }] },
    });
    expect(missing.statusCode).toBe(500);
    expect(missing.json().message).toMatch(/not found/);

    const unauthenticated = await app.inject({
      method: 'PUT',
      url: '/api/hosts/order',
      payload: { hosts: [] },
    });
    expect(unauthenticated.statusCode).toBe(401);
  });
});
