import { describe, expect, it } from 'vitest';
import { serverUrls, websocketHeaderHasToken } from '../../../server/src/auth.js';

describe('websocketHeaderHasToken', () => {
  it('accepts the exact auth protocol among the offered protocols', () => {
    expect(websocketHeaderHasToken('muxus.terminal.v1, muxus.auth.secret', 'secret')).toBe(true);
  });

  it('rejects missing, partial, and wrong credentials', () => {
    expect(websocketHeaderHasToken(undefined, 'secret')).toBe(false);
    expect(websocketHeaderHasToken('muxus.terminal.v1, muxus.auth.sec', 'secret')).toBe(false);
    expect(websocketHeaderHasToken('muxus.terminal.v1, muxus.auth.other', 'secret')).toBe(false);
  });
});

describe('serverUrls', () => {
  it('keeps credentials out of the public and HTTP-request portions', () => {
    const urls = serverUrls('127.0.0.1', 4321, 'top-secret');
    expect(urls.publicUrl).toBe('http://127.0.0.1:4321/');
    expect(urls.publicUrl).not.toContain('top-secret');

    const bootstrap = new URL(urls.browserUrl);
    expect(bootstrap.search).toBe('');
    expect(bootstrap.hash).toBe('#token=top-secret');
  });
});
