import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'app-route-test-token';
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
  vi.unstubAllGlobals();
  await app.close();
});

describe('app routes', () => {
  it('validates update manifests and reports a newer trusted release', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 'v0.8.0',
          releaseName: 'Muxus 0.8',
          releaseUrl: 'https://github.com/FloSch62/muxus/releases/tag/v0.8.0',
          publishedAt: '2026-07-26T08:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'GET',
      url: '/api/app/update-check?force=true',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: true,
      currentVersion: '0.7.0',
      latestVersion: '0.8.0',
      releaseName: 'Muxus 0.8',
      releaseUrl: 'https://github.com/FloSch62/muxus/releases/tag/v0.8.0',
      publishedAt: '2026-07-26T08:00:00Z',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/flosch62\.github\.io\/muxus\/latest\.json\?t=\d+$/,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Accept: 'application/json', 'User-Agent': 'Muxus/0.7.0' },
    });
  });

  it('rejects an update manifest that points outside the Muxus releases page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: '0.8.0',
            releaseUrl: 'https://attacker.example/FloSch62/muxus/releases/tag/v0.8.0',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/app/update-check?force=true',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: false,
      currentVersion: '0.7.0',
      latestVersion: '0.8.0',
      reason: 'missing-release-url',
    });
  });

  it('reports X11 status and applies settings over the platform defaults', async () => {
    const headers = { authorization: `Bearer ${TOKEN}` };
    const initial = await app.inject({ method: 'GET', url: '/api/x11', headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ clipboard: false, defaults: expect.any(Object) });

    const accepted = await app.inject({
      method: 'PUT',
      url: '/api/x11/settings',
      headers,
      payload: { enabled: false, forwardByDefault: true, clipboard: true },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ enabled: false, forwardByDefault: true, clipboard: true });

    const reverted = await app.inject({
      method: 'PUT',
      url: '/api/x11/settings',
      headers,
      payload: { clipboard: false },
    });
    const status = reverted.json();
    expect(status.enabled).toBe(status.defaults.enabled);
    expect(status.forwardByDefault).toBe(status.defaults.forwardByDefault);

    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/x11/settings',
      headers,
      payload: { clipboard: 'yes' },
    });
    expect(rejected.statusCode).toBe(400);
  });
});
