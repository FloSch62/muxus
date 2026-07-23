import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'security-header-test-token';
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

describe('security headers', () => {
  it('permits xterm WebAssembly without enabling general script evaluation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/app/info',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const policy = response.headers['content-security-policy'];
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).not.toMatch(/(?:^|[\s;])'unsafe-eval'(?:[\s;]|$)/);
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
