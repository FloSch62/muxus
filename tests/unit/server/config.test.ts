import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../../server/src/config.js';

describe('resolveConfig', () => {
  it('binds localhost with a fresh random token by default', () => {
    const a = resolveConfig();
    const b = resolveConfig();
    expect(a.host).toBe('127.0.0.1');
    expect(a.port).toBe(3002);
    expect(a.token).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
  });

  it('uses the dev token when provided', () => {
    expect(resolveConfig({ devToken: 'dev' }).token).toBe('dev');
  });

  it('applies overrides', () => {
    const config = resolveConfig({ port: 0, openBrowser: false, staticRoot: '/tmp/x' });
    expect(config.port).toBe(0);
    expect(config.openBrowser).toBe(false);
    expect(config.staticRoot).toBe('/tmp/x');
  });
});
