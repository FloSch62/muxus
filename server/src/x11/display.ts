import fs from 'node:fs';
import { connectLocalSocket, connectLocalTcp, type LocalStream } from '../ssh/engine.js';
import { xauthTargetForPeer, type XauthTarget } from './xauthority.js';

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
}

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
    };
  }

  const host = rawHost.replace(/^\[(.*)\]$/, '$1');
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
  };
}

/** Which Xauthority records apply to a connection to `endpoint`. */
export function xauthTarget(endpoint: X11Endpoint, stream: Pick<LocalStream, 'peerAddress'>): XauthTarget {
  return endpoint.kind === 'unix' ? { local: true } : xauthTargetForPeer(stream.peerAddress ?? undefined);
}

/**
 * Open a stream to the X server; Unix sockets fall back to the abstract
 * namespace. The SSH engine holds the stream, so a forwarded connection is
 * joined to it without its bytes passing through JavaScript.
 */
export async function connectX11Endpoint(endpoint: X11Endpoint, timeoutMs = 5000): Promise<LocalStream> {
  if (endpoint.kind === 'tcp') {
    // X11 is small requests waiting on replies; the engine turns Nagle off,
    // as Xlib and ssh(1) do on X connections.
    return connect(connectLocalTcp(endpoint.host, endpoint.port, timeoutMs));
  }
  if (!endpoint.abstract || fs.existsSync(endpoint.path)) {
    try {
      return await connect(connectLocalSocket(endpoint.path, timeoutMs));
    } catch (err) {
      if (!endpoint.abstract) throw err;
    }
  }
  return connect(connectLocalSocket(endpoint.abstract, timeoutMs));
}

async function connect(attempt: Promise<LocalStream>): Promise<LocalStream> {
  try {
    return await attempt;
  } catch (err) {
    if ((err as { code?: unknown } | undefined)?.code === 'ETIMEDOUT') {
      throw new Error('timed out connecting to the local X server');
    }
    throw err;
  }
}
