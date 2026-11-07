import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  Menu: {},
  session: {},
}));

const { parseWebWindowRequest } = await import('../../../electron/src/web-windows.js');

describe('web window requests', () => {
  const base = { key: 'abc_1', url: 'https://grafana.internal:3000/d/x', title: 'Grafana' };

  it('accepts a page, with its proxy and the forward behind it', () => {
    expect(parseWebWindowRequest(base)).toEqual(base);
    expect(
      parseWebWindowRequest({ ...base, proxy: 'socks5://127.0.0.1:50123', forwardId: 'Ab3_-x9' }),
    ).toEqual({ ...base, proxy: 'socks5://127.0.0.1:50123', forwardId: 'Ab3_-x9' });
  });

  it('refuses what a browser window should not open', () => {
    expect(parseWebWindowRequest({ ...base, url: 'file:///etc/passwd' })).toBeUndefined();
    expect(parseWebWindowRequest({ ...base, url: 'http://[fe80::1%eth0]/' })).toBeUndefined();
    expect(parseWebWindowRequest({ ...base, proxy: 'socks5://10.0.0.1:1080' })).toBeUndefined();
    expect(parseWebWindowRequest({ ...base, forwardId: '../../x' })).toBeUndefined();
    expect(parseWebWindowRequest({ ...base, key: 'a b' })).toBeUndefined();
  });
});
