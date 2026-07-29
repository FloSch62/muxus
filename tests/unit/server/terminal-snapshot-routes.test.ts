import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'snapshot-test-token';
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

function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}

describe('terminal snapshot routes', () => {
  it('round-trips a snapshot for a tab', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/terminal-snapshots/tab-1',
      headers: auth(),
      payload: {
        data: 'deploy@web-01:~$ uptime\r\n 09:15 up 42 days',
        formatVersion: 2,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ saved: true });

    const get = await app.inject({
      method: 'GET',
      url: '/api/terminal-snapshots/tab-1',
      headers: auth(),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().snapshot).toMatchObject({
      tabId: 'tab-1',
      data: 'deploy@web-01:~$ uptime\r\n 09:15 up 42 days',
      formatVersion: 2,
    });
  });

  it('answers null for a tab that never saved output', async () => {
    const get = await app.inject({
      method: 'GET',
      url: '/api/terminal-snapshots/never-seen',
      headers: auth(),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ snapshot: null });
  });

  it('rejects empty and malformed snapshots', async () => {
    const empty = await app.inject({
      method: 'PUT',
      url: '/api/terminal-snapshots/tab-1',
      headers: auth(),
      payload: { data: '' },
    });
    expect(empty.statusCode).toBe(400);

    const wrongShape = await app.inject({
      method: 'PUT',
      url: '/api/terminal-snapshots/tab-1',
      headers: auth(),
      payload: { scrollback: 'not the field' },
    });
    expect(wrongShape.statusCode).toBe(400);
  });

  it('requires the bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/terminal-snapshots/tab-1' });
    expect(res.statusCode).toBe(401);
  });
});
