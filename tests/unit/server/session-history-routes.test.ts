import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'session-history-test-token';
let built: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  built = await buildApp(
    resolveConfig({
      token: TOKEN,
      databasePath: ':memory:',
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }),
  );
});

afterEach(async () => {
  await built.app.close();
});

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

function seedSession(): string {
  const policy = { maxPartBytes: 1024 * 1024, maxParts: 2 };
  const id = built.ctx.history.beginSession(
    {
      profileKey: 'ssh:production',
      title: 'Production',
      kind: 'ssh',
      host: 'production',
      startedAt: '2026-07-24T12:00:00.000Z',
      captureInput: false,
    },
    policy,
  );
  built.ctx.history.append(
    id,
    [{
      sequence: 1,
      recordedAt: '2026-07-24T12:00:01.000Z',
      elapsedMs: 1_000,
      direction: 'output',
      raw: Buffer.from('\x1b[32mdeploy complete\x1b[0m\r\n'),
      text: 'deploy complete\n',
    }],
    policy,
  );
  built.ctx.history.finishSession(id, 'completed', '2026-07-24T12:00:02.000Z');
  return id;
}

describe('session history routes', () => {
  it('requires authentication and full-text searches retained transcripts', async () => {
    seedSession();
    const unauthorized = await built.app.inject({
      method: 'GET',
      url: '/api/session-history',
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/session-history?query=deploy',
      headers: auth(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessions: [expect.objectContaining({ title: 'Production' })],
    });
  });

  it('exports clean text, standalone HTML replay, and timestamped raw NDJSON', async () => {
    const id = seedSession();
    const clean = await built.app.inject({
      method: 'GET',
      url: `/api/session-history/${id}/clean`,
      headers: auth(),
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.headers['content-type']).toContain('text/plain');
    expect(clean.headers['content-disposition']).toContain('-clean.txt');
    expect(clean.body).toBe('deploy complete\n');
    expect(clean.body).not.toContain('\x1b');

    const replay = await built.app.inject({
      method: 'GET',
      url: `/api/session-history/${id}/replay.html`,
      headers: auth(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['content-type']).toContain('text/html');
    expect(replay.body).toContain('Muxus replay');
    expect(replay.body).toContain('deploy complete');

    const raw = await built.app.inject({
      method: 'GET',
      url: `/api/session-history/${id}/raw`,
      headers: auth(),
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toContain('application/x-ndjson');
    expect(JSON.parse(raw.body.trim())).toMatchObject({
      elapsedMs: 1000,
      direction: 'output',
      encoding: 'base64',
    });
  });

  it('round-trips host policies with safe bounds', async () => {
    const url =
      '/api/session-history/policy?profileKey=' +
      encodeURIComponent('ssh:production');
    const saved = await built.app.inject({
      method: 'PUT',
      url,
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: {
        enabled: true,
        captureInput: true,
        maxPartBytes: 2 * 1024 * 1024,
        maxParts: 6,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      profileKey: 'ssh:production',
      captureInput: true,
      maxParts: 6,
      overridden: true,
    });

    const invalid = await built.app.inject({
      method: 'PUT',
      url,
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: {
        enabled: true,
        captureInput: false,
        maxPartBytes: 1,
        maxParts: 0,
      },
    });
    expect(invalid.statusCode).toBe(400);

    const removed = await built.app.inject({
      method: 'DELETE',
      url,
      headers: auth(),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ deleted: true });

    const inherited = await built.app.inject({
      method: 'GET',
      url,
      headers: auth(),
    });
    expect(inherited.statusCode).toBe(200);
    expect(inherited.json()).toMatchObject({
      profileKey: 'ssh:production',
      enabled: false,
      captureInput: false,
      overridden: false,
    });
  });

  it('reports actual storage usage and validates global retention settings', async () => {
    seedSession();
    const current = await built.app.inject({
      method: 'GET',
      url: '/api/session-history/storage',
      headers: auth(),
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      settings: {
        maxTotalBytes: 5 * 1024 ** 3,
        minFreeBytes: 2 * 1024 ** 3,
        minFreePercent: 5,
      },
      usageBytes: expect.any(Number),
      freeBytes: expect.any(Number),
      quotaSuspended: expect.any(Boolean),
    });

    const saved = await built.app.inject({
      method: 'PUT',
      url: '/api/session-history/storage',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: {
        storageLocation: '/tmp/muxus-history-on-another-disk',
        maxTotalBytes: 64 * 1024 ** 2,
        minFreeBytes: 0,
        minFreePercent: 0,
        maxAgeDays: 30,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      settings: {
        storageLocation: '/tmp/muxus-history-on-another-disk',
        maxAgeDays: 30,
      },
      restartRequired: true,
    });

    const invalid = await built.app.inject({
      method: 'PUT',
      url: '/api/session-history/storage',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: {
        storageLocation: 'relative/history',
        maxTotalBytes: 64 * 1024 ** 2,
        minFreeBytes: 0,
        minFreePercent: 0,
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('pins completed sessions against retention cleanup', async () => {
    const id = seedSession();
    const pinned = await built.app.inject({
      method: 'PUT',
      url: `/api/session-history/${id}/pin`,
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: { pinned: true },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toEqual({ updated: true });

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/session-history',
      headers: auth(),
    });
    expect(response.json()).toMatchObject({
      sessions: [expect.objectContaining({ id, pinned: true })],
    });
  });
});
