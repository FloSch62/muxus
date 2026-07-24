import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'ssh-route-test-token';
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

describe('OpenSSH host keyword metadata', () => {
  it('persists validated per-host highlighting without rewriting ssh_config', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/ssh/config/hosts/production/metadata',
      headers: auth(),
      payload: {
        keywordHighlights: {
          inheritGlobal: false,
          rules: [
            {
              id: 'failed',
              keyword: 'FAILED',
              foreground: '#ffffff',
              background: '#991b1b',
              caseSensitive: true,
              wholeWord: true,
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      keywordHighlights: {
        inheritGlobal: false,
        rules: [expect.objectContaining({ keyword: 'FAILED' })],
      },
    });
  });

  it('rejects invalid terminal decoration colors', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/ssh/config/hosts/production/metadata',
      headers: auth(),
      payload: {
        keywordHighlights: {
          inheritGlobal: true,
          rules: [
            {
              id: 'bad',
              keyword: 'ERROR',
              foreground: 'red',
              caseSensitive: false,
              wholeWord: false,
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
