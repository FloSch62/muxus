import fs from 'node:fs';
import net from 'node:net';
import type { XauthTarget } from './xauthority.js';

/** X display numbers map to TCP ports 6000 + n. */
export const X11_TCP_PORT_BASE = 6000;

/** Where a local X server accepts connections. */
export type X11Endpoint =
  | { kind: 'unix'; path: string; /** Linux abstract-namespace fallback. */ abstract?: string }
  | { kind: 'tcp'; host: string; port: number };

export interface ParsedDisplay {
  endpoint: X11Endpoint;
  /** Display number as Xauthority records it ("0"). */
  number: string;
  screen: number;
  /** Which Xauthority records apply to this display. */
  xauth: XauthTarget;
}

const LOCAL_HOSTS = new Set(['', 'unix', 'localhost', '127.0.0.1', '::1']);

/**
 * Parse $DISPLAY the way ssh(1) connects to it: `:n`/`unix:n` use the X11
 * Unix socket (TCP on Windows, where X servers only listen there), a leading
 * `/` is a socket path such as XQuartz's launchd socket, and `host:n` is TCP
 * port 6000 + n. A trailing `.screen` is optional everywhere.
 */
export function parseDisplay(
  display: string,
  platform: NodeJS.Platform = process.platform,
): ParsedDisplay | undefined {
  const value = display.trim();
  const match = /^(.*):(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return undefined;
  const [, rawHost = '', number = '', screenText] = match;
  const screen = screenText ? Number(screenText) : 0;
  const displayNumber = Number(number);

  if (rawHost.startsWith('/')) {
    // XQuartz's socket file is literally named "…/org.xquartz:0".
    return {
      endpoint: { kind: 'unix', path: `${rawHost}:${number}` },
      number,
      screen,
      xauth: { local: true },
    };
  }

  const host = rawHost.replace(/^\[(.*)\]$/, '$1');
  const local = LOCAL_HOSTS.has(host);
  if ((host === '' || host === 'unix') && platform !== 'win32') {
    const socket = `/tmp/.X11-unix/X${number}`;
    return {
      endpoint: {
        kind: 'unix',
        path: socket,
        ...(platform === 'linux' ? { abstract: `\0${socket}` } : {}),
      },
      number,
      screen,
      xauth: { local: true },
    };
  }
  return {
    endpoint: {
      kind: 'tcp',
      host: host === '' || host === 'unix' ? '127.0.0.1' : host,
      port: X11_TCP_PORT_BASE + displayNumber,
    },
    number,
    screen,
    xauth: local ? { local: true } : { local: false, host },
  };
}

/** Open a stream to the X server; Unix sockets fall back to the abstract namespace. */
export async function connectX11Endpoint(endpoint: X11Endpoint, timeoutMs = 5000): Promise<net.Socket> {
  if (endpoint.kind === 'tcp') {
    // X11 is small requests waiting on replies; Nagle plus delayed ACKs would
    // stall them. Xlib and ssh(1) disable it on X connections too.
    return connect({ host: endpoint.host, port: endpoint.port, noDelay: true }, timeoutMs);
  }
  if (!endpoint.abstract || fs.existsSync(endpoint.path)) {
    try {
      return await connect({ path: endpoint.path }, timeoutMs);
    } catch (err) {
      if (!endpoint.abstract) throw err;
    }
  }
  return connect({ path: endpoint.abstract }, timeoutMs);
}

function connect(options: net.NetConnectOpts, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out connecting to the local X server'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    });
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once('error', onError);
  });
}
