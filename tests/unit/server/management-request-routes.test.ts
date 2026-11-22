import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SavedManagementRequest } from '@muxus/shared';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'management-request-route-token';
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

const headers = { authorization: `Bearer ${TOKEN}` };
const request = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const names = (body: { requests: SavedManagementRequest[] }) => body.requests.map((saved) => saved.name);

describe('saved management request routes', () => {
  it('lists the requests of one host, and all of them for a backup', async () => {
    await request('PUT', '/api/management/requests', {
      protocol: 'gnmi',
      profileId: 'leaf-1',
      name: 'Counters',
      request: { operation: 'subscribe' },
    });
    await request('PUT', '/api/management/requests', {
      protocol: 'gnmi',
      profileId: 'leaf-2',
      name: 'Neighbors',
      request: { operation: 'get' },
    });
    await request('PUT', '/api/management/requests', { protocol: 'gnmi', name: 'System', request: {} });
    await request('PUT', '/api/management/requests', { protocol: 'netconf', name: 'Running', request: {} });

    // One host sees its own and the shared ones of its protocol.
    expect(names((await request('GET', '/api/management/requests?protocol=gnmi&profileId=leaf-1')).json())).toEqual([
      'Counters',
      'System',
    ]);
    expect(names((await request('GET', '/api/management/requests/all')).json())).toEqual([
      'Counters',
      'Neighbors',
      'System',
      'Running',
    ]);
  });

  it('puts a request back under the ID a restore gives', async () => {
    const saved = (
      await request('PUT', '/api/management/requests', {
        id: 'from-a-backup',
        protocol: 'netconf',
        name: 'Running',
        request: { operation: 'get-config' },
      })
    ).json() as SavedManagementRequest;
    expect(saved).toMatchObject({ id: 'from-a-backup', protocol: 'netconf', name: 'Running' });

    await request('PUT', '/api/management/requests', {
      id: 'from-a-backup',
      protocol: 'netconf',
      name: 'Candidate',
      request: { operation: 'get-config', source: 'candidate' },
    });
    const all = (await request('GET', '/api/management/requests/all')).json() as { requests: SavedManagementRequest[] };
    expect(all.requests).toHaveLength(1);
    expect(all.requests[0]).toMatchObject({ id: 'from-a-backup', name: 'Candidate' });
  });
});
