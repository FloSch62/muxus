import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'tunnel-test-token';
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

describe('saved tunnel routes', () => {
  it('round-trips a persistent tunnel with a custom SSH profile', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tunnels',
      headers: auth(),
      payload: {
        name: 'Database',
        target: 'db.internal',
        sshOptions: {
          user: 'deploy',
          port: 2222,
          identityFiles: ['~/.ssh/work_ed25519'],
          identitiesOnly: true,
          proxyJump: ['bastion'],
        },
        type: 'local',
        bindPort: 5432,
        targetHost: 'localhost',
        targetPort: 5432,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'Database',
      target: 'db.internal',
      sshOptions: {
        user: 'deploy',
        port: 2222,
        identityFiles: ['~/.ssh/work_ed25519'],
        identitiesOnly: true,
        proxyJump: ['bastion'],
      },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/tunnels',
      headers: auth(),
    });
    expect(list.json().tunnels).toEqual([response.json()]);
  });

  it('rejects credentials in a tunnel profile', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tunnels',
      headers: auth(),
      payload: {
        target: 'db.internal',
        sshOptions: { user: 'deploy', password: 'do-not-store-this' },
        type: 'dynamic',
        bindPort: 1080,
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
