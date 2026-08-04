import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'ssh-route-test-token';
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let home: string;

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'muxus-ssh-routes-'));
  vi.stubEnv('HOME', home);
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
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

describe('OpenSSH host keyword metadata', () => {
  it('persists the per-host SFTP compatibility setting', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/ssh/config/hosts/production/metadata',
      headers: auth(),
      payload: { disableSftp: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ disableSftp: true });
  });

  it('persists validated per-host highlighting without rewriting ssh_config', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/ssh/config/hosts/production/metadata',
      headers: auth(),
      payload: {
        keywordHighlights: {
          inheritGlobal: false,
          profileId: 'nokia-sros',
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
        profileId: 'nokia-sros',
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

  it('rejects an empty reusable highlighting profile ID', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/ssh/config/hosts/production/metadata',
      headers: auth(),
      payload: {
        keywordHighlights: {
          inheritGlobal: true,
          profileId: '',
          rules: [],
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('OpenSSH agent routes', () => {
  it('persists IdentityAgent from the validated host payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ssh/config/hosts',
      headers: {
        ...auth(),
        'content-type': 'application/json',
      },
      payload: {
        aliases: ['muxus-identity-agent-route-test'],
        options: {
          hostname: 'example.test',
          identityAgent: '${ONEPASSWORD_SSH_AUTH_SOCK}',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(readFileSync(path.join(home, '.ssh', 'config'), 'utf8')).toContain(
      'IdentityAgent ${ONEPASSWORD_SSH_AUTH_SOCK}',
    );
  });

  it('uses the requested host-editor agent source for key detection', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ssh/keys?identityAgent=none',
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentAvailable: false,
      agentKeys: [],
    });
  });

  it('reports an unreachable custom agent as unavailable', async () => {
    const identityAgent = path.join(home, 'missing-agent.sock');
    const response = await app.inject({
      method: 'GET',
      url: `/api/ssh/keys?identityAgent=${encodeURIComponent(identityAgent)}`,
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentAvailable: false,
      agentKeys: [],
    });
  });
});
