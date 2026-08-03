import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'profile-test-token';
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

describe('saved host profile routes', () => {
  it('creates and updates an imported profile with a caller-supplied ID', async () => {
    const id = 'securecrt-serial-2p5f9abc';
    const create = await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        id,
        name: 'Imported console',
        profile: {
          kind: 'serial',
          path: '/dev/ttyUSB0',
          baudRate: 115200,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          flowControl: 'none',
        },
      },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json()).toMatchObject({ id, name: 'Imported console' });

    const organize = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${id}/metadata`,
      headers: auth(),
      payload: { group: 'Lab/Consoles' },
    });
    expect(organize.statusCode).toBe(200);

    const update = await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        id,
        name: 'Updated console',
        profile: {
          kind: 'serial',
          path: '/dev/ttyUSB1',
          baudRate: 9600,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          flowControl: 'software',
        },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      id,
      name: 'Updated console',
      profile: { path: '/dev/ttyUSB1', baudRate: 9600 },
      metadata: { group: 'Lab/Consoles' },
    });
  });

  it('manages Telnet and serial hosts through the authenticated host API', async () => {
    const create = await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        name: 'Console server',
        profile: {
          kind: 'telnet',
          host: 'console.example.test',
          port: 2323,
        },
      },
    });

    expect(create.statusCode).toBe(200);
    const created = create.json();
    expect(created).toMatchObject({
      kind: 'telnet',
      name: 'Console server',
      profile: {
        kind: 'telnet',
        host: 'console.example.test',
        port: 2323,
      },
    });
    expect(created.profile.profileId).toBe(created.id);

    const organize = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${created.id}/metadata`,
      headers: auth(),
      payload: {
        group: 'Network lab',
        color: '#22c55e',
      },
    });
    expect(organize.statusCode).toBe(200);
    expect(organize.json()).toMatchObject({
      id: created.id,
      metadata: {
        group: 'Network lab',
        color: '#22c55e',
      },
    });

    const highlights = {
      inheritGlobal: false,
      rules: [
        {
          id: 'rule-1',
          keyword: 'ERROR',
          foreground: '#ff0000',
          caseSensitive: true,
          wholeWord: true,
        },
      ],
    };
    const highlighted = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${created.id}/metadata`,
      headers: auth(),
      payload: { keywordHighlights: highlights },
    });
    expect(highlighted.statusCode).toBe(200);
    expect(highlighted.json().metadata.keywordHighlights).toEqual(highlights);

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${created.id}/metadata`,
      headers: auth(),
      payload: { keywordHighlights: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().metadata.keywordHighlights).toBeUndefined();

    const update = await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        id: created.id,
        name: 'USB console',
        profile: {
          kind: 'serial',
          path: 'COM3',
          baudRate: 9600,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          flowControl: 'none',
        },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      id: created.id,
      kind: 'serial',
      name: 'USB console',
      profile: {
        kind: 'serial',
        path: 'COM3',
        baudRate: 9600,
      },
      metadata: {
        group: 'Network lab',
      },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: auth(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().profiles).toEqual([update.json()]);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/profiles/${created.id}`,
      headers: auth(),
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toEqual({ deleted: true });
  });

  it('rejects unauthenticated and invalid saved host requests', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/profiles',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        name: 'Broken serial host',
        profile: {
          kind: 'serial',
          path: '',
          baudRate: 0,
        },
      },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
