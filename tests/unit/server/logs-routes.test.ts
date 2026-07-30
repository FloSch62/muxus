import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';
import { clearAppLog } from '../../../server/src/logging/log-buffer.js';

const TOKEN = 'logs-route-test-token';
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeEach(async () => {
  clearAppLog();
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

const auth = { authorization: `Bearer ${TOKEN}` };

describe('log routes', () => {
  it('serves buffered server log entries', async () => {
    app.log.warn({ host: 'db.example.com' }, 'ssh dial failed');

    const response = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.debugEnabled).toBe(false);
    expect(body.capacity).toBeGreaterThan(0);
    expect(body.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        source: 'server',
        msg: 'ssh dial failed',
        context: { host: 'db.example.com' },
      }),
    );
  });

  it('does not capture debug records until debug mode is enabled', async () => {
    app.log.debug('hidden detail');
    const before = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });
    expect(before.json().entries).not.toContainEqual(
      expect.objectContaining({ msg: 'hidden detail' }),
    );

    const put = await app.inject({
      method: 'PUT',
      url: '/api/logs/settings',
      headers: auth,
      payload: { debugEnabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ debugEnabled: true });

    app.log.debug('visible detail');
    const after = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });
    expect(after.json().debugEnabled).toBe(true);
    expect(after.json().entries).toContainEqual(
      expect.objectContaining({ level: 'debug', msg: 'visible detail' }),
    );
  });

  it('restores the base level when debug mode is disabled', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/logs/settings',
      headers: auth,
      payload: { debugEnabled: true },
    });
    const off = await app.inject({
      method: 'PUT',
      url: '/api/logs/settings',
      headers: auth,
      payload: { debugEnabled: false },
    });
    expect(off.json()).toEqual({ debugEnabled: false });
    expect(app.log.level).toBe('info');

    // Toggling leaves an audit trail in the buffer itself.
    const logs = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });
    const messages = logs.json().entries.map((e: { msg: string }) => e.msg);
    expect(messages).toContain('debug logging enabled');
    expect(messages).toContain('debug logging disabled');
  });

  it('rejects a malformed settings body', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/logs/settings',
      headers: auth,
      payload: { debugEnabled: 'yes' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('clears the buffer', async () => {
    app.log.warn('to be cleared');
    const cleared = await app.inject({ method: 'DELETE', url: '/api/logs', headers: auth });
    expect(cleared.json()).toEqual({ cleared: true });

    const logs = await app.inject({ method: 'GET', url: '/api/logs', headers: auth });
    expect(logs.json().entries).not.toContainEqual(
      expect.objectContaining({ msg: 'to be cleared' }),
    );
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/logs' });
    expect(response.statusCode).toBe(401);
  });
});
