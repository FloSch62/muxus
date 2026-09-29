import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import { createWebSocketStream, type WebSocket } from 'ws';
import {
  decodeRDCleanPathRequest,
  encodeRDCleanPathError,
  encodeRDCleanPathNegotiationError,
  encodeRDCleanPathResponse,
  RDCLEANPATH_GENERAL_ERROR,
  RDCLEANPATH_MAX_REQUEST_BYTES,
  rdCleanPathPduLength,
  type RDCleanPathError,
} from './rdcleanpath.js';
import { parseConnectionConfirm, tpktLength, X224_MAX_CONFIRM_BYTES } from './x224.js';
import {
  presentedCertificate,
  serverName,
  trustedCertificateAuthorities,
  type PresentedCertificate,
} from './certificates.js';

const REQUEST_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

/** The remote end of one RDP connection, bound to a single-use ticket. */
export interface RdpStreamTarget {
  host: string;
  port: number;
  /** Open the TCP path to the server (directly or through an SSH gateway). */
  open(): Promise<Duplex>;
  /** Accept the server's TLS certificate, asking the user when it is not trusted. */
  acceptCertificate(certificate: PresentedCertificate): Promise<boolean>;
  /** Tear the stream down when the owning tab goes away; returns an unsubscribe. */
  onAbort(abort: (reason: string) => void): () => void;
}

/** Socket and resolver failures in the WSA codes IronRDP knows how to explain. */
export function connectErrorPdu(err: unknown): RDCleanPathError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const wsa: Record<string, number> = {
    ECONNREFUSED: 10061,
    ETIMEDOUT: 10060,
    EHOSTUNREACH: 10065,
    ENETUNREACH: 10051,
    ECONNRESET: 10054,
    ENOTFOUND: 11001,
    EAI_AGAIN: 11002,
  };
  const wsaLastError = code ? wsa[code] : undefined;
  return wsaLastError
    ? { errorCode: RDCLEANPATH_GENERAL_ERROR, wsaLastError }
    : { errorCode: RDCLEANPATH_GENERAL_ERROR, httpStatusCode: 502 };
}

class HandshakeError extends Error {
  constructor(
    message: string,
    readonly pdu: Buffer,
  ) {
    super(message);
  }
}

function httpError(status: number, message: string): HandshakeError {
  return new HandshakeError(
    message,
    encodeRDCleanPathError({ errorCode: RDCLEANPATH_GENERAL_ERROR, httpStatusCode: status }),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Collect the client's RDCleanPath request, however it was split into frames. */
function readRequest(socket: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        cleanup();
        reject(new Error('expected a binary RDCleanPath request'));
        return;
      }
      buffered = Buffer.concat([buffered, data]);
      try {
        const length = rdCleanPathPduLength(buffered);
        if (length !== undefined && length > RDCLEANPATH_MAX_REQUEST_BYTES) {
          throw new Error('RDCleanPath request is too large');
        }
        if (length === undefined || buffered.length < length) {
          if (buffered.length > RDCLEANPATH_MAX_REQUEST_BYTES) throw new Error('RDCleanPath request is too large');
          return;
        }
        if (buffered.length > length) throw new Error('unexpected data after the RDCleanPath request');
        cleanup();
        resolve(buffered);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('the client closed before sending its request'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for the RDCleanPath request'));
    }, REQUEST_TIMEOUT_MS);
    socket.on('message', onMessage);
    socket.once('close', onClose);
  });
}

/** Read exactly one TPKT frame (the X.224 Connection Confirm) off the server stream. */
function readConnectionConfirm(stream: Duplex): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      try {
        const length = tpktLength(buffered);
        if (length === undefined) return;
        if (length > X224_MAX_CONFIRM_BYTES) throw new Error('the server sent an oversized X.224 confirm');
        if (buffered.length < length) return;
        if (buffered.length > length) throw new Error('the server sent data before TLS was negotiated');
        cleanup();
        stream.pause();
        resolve(buffered);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(Object.assign(new Error('the server closed the connection during negotiation'), { code: 'ECONNRESET' }));
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

function upgradeToTls(stream: Duplex, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      socket: stream,
      servername: serverName(host),
      // Verification happens in acceptCertificate: RDP certificates are
      // usually self-signed, and a failed chain must reach the user, not
      // abort the handshake.
      rejectUnauthorized: false,
      ca: trustedCertificateAuthorities(),
    });
    const onError = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once('secureConnect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
    socket.once('error', onError);
  });
}

function tlsErrorPdu(err: unknown): Buffer {
  // OpenSSL reports a received alert as "…SSL alert number 40".
  const alert = /alert number (\d+)/i.exec(err instanceof Error ? err.message : '')?.[1];
  return encodeRDCleanPathError(
    alert
      ? { errorCode: RDCLEANPATH_GENERAL_ERROR, tlsAlertCode: Number(alert) }
      : { errorCode: RDCLEANPATH_GENERAL_ERROR, httpStatusCode: 502 },
  );
}

/**
 * Serve one IronRDP connection on /ws/desktop/rdp: authenticate its ticket,
 * do the X.224 and TLS legs against the server on the client's behalf, then
 * relay the (now encrypted to the server) RDP stream until either side ends.
 */
export async function serveRdpCleanPath(
  socket: WebSocket,
  redeem: (ticket: string) => RdpStreamTarget | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  let upstream: Duplex | undefined;
  let secure: tls.TLSSocket | undefined;
  let unsubscribeAbort: (() => void) | undefined;
  /** The tab or the client went away; anything opened from now on is discarded. */
  let aborted = false;
  const closeAll = () => {
    aborted = true;
    unsubscribeAbort?.();
    secure?.destroy();
    upstream?.destroy();
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close();
  };
  socket.once('close', () => {
    aborted = true;
    unsubscribeAbort?.();
    secure?.destroy();
    upstream?.destroy();
  });
  // The server side can fail at any point, including while the user is still
  // looking at the certificate prompt; an unhandled 'error' would take the
  // whole process down. The handshake steps notice through their own awaits.
  const noteServerError = (err: Error) => log.debug({ err }, 'rdp server stream failed');
  /** Resolve an opening stream, destroying it if it arrives after we gave up. */
  const settle = async <T extends Duplex>(opening: Promise<T>, message: string): Promise<T> => {
    try {
      const stream = await withTimeout(opening, HANDSHAKE_TIMEOUT_MS, message);
      stream.on('error', noteServerError);
      return stream;
    } catch (err) {
      void opening.then((late) => late.destroy(), () => undefined);
      throw err;
    }
  };

  try {
    let request;
    try {
      request = decodeRDCleanPathRequest(await readRequest(socket));
    } catch (err) {
      throw new HandshakeError(err instanceof Error ? err.message : String(err), encodeRDCleanPathError({
        errorCode: RDCLEANPATH_GENERAL_ERROR,
        httpStatusCode: 400,
      }));
    }
    const target = redeem(request.proxyAuth);
    if (!target) throw httpError(401, 'unknown or expired RDP ticket');
    unsubscribeAbort = target.onAbort((reason) => {
      log.debug({ host: target.host, reason }, 'rdp stream aborted');
      closeAll();
    });

    try {
      upstream = await settle(target.open(), 'timed out connecting to the RDP server');
    } catch (err) {
      throw new HandshakeError(
        err instanceof Error ? err.message : String(err),
        encodeRDCleanPathError(connectErrorPdu(err)),
      );
    }
    if (aborted) {
      upstream.destroy();
      return;
    }
    // Legacy clients put a complete preconnection blob in the request.
    if (request.preconnectionBlob) upstream.write(Buffer.from(request.preconnectionBlob, 'utf8'));
    upstream.write(request.x224ConnectionPdu);
    let confirm: Buffer;
    try {
      confirm = await withTimeout(
        readConnectionConfirm(upstream),
        HANDSHAKE_TIMEOUT_MS,
        'timed out waiting for the RDP server',
      );
    } catch (err) {
      throw new HandshakeError(
        err instanceof Error ? err.message : String(err),
        encodeRDCleanPathError(connectErrorPdu(err)),
      );
    }
    if (aborted) return;
    const negotiated = parseConnectionConfirm(confirm);
    if (negotiated.kind !== 'response' || negotiated.protocol === 0) {
      // A refusal, or a server that only speaks standard RDP security: the
      // client decodes the confirm itself and explains which one it was.
      throw new HandshakeError('the RDP server refused TLS', encodeRDCleanPathNegotiationError(confirm));
    }

    try {
      secure = await settle(upgradeToTls(upstream, target.host), 'TLS handshake timed out');
    } catch (err) {
      throw new HandshakeError(err instanceof Error ? err.message : String(err), tlsErrorPdu(err));
    }
    if (aborted) {
      closeAll();
      return;
    }
    const certificate = presentedCertificate(secure, target.host);
    if (!certificate) throw httpError(502, 'the RDP server presented no certificate');
    if (!(await target.acceptCertificate(certificate))) {
      throw httpError(403, 'the server certificate was not trusted');
    }
    if (aborted || socket.readyState !== socket.OPEN) {
      closeAll();
      return;
    }
    if (secure.destroyed) {
      throw new HandshakeError(
        'the RDP server closed the connection',
        encodeRDCleanPathError(connectErrorPdu({ code: 'ECONNRESET' })),
      );
    }

    // Through an SSH gateway only the gateway knows the resolved address.
    const serverAddress =
      upstream instanceof net.Socket && upstream.remoteAddress
        ? `${upstream.remoteAddress}:${upstream.remotePort ?? target.port}`
        : `${target.host}:${target.port}`;
    socket.send(encodeRDCleanPathResponse(serverAddress, confirm, certificate.chain));
    log.info({ host: target.host, port: target.port, tls: secure.getProtocol() }, 'rdp session established');

    // From here the WebSocket is a plain byte stream in both directions.
    const client = createWebSocketStream(socket);
    client.on('error', () => closeAll());
    secure.on('error', () => closeAll());
    secure.once('close', () => client.destroy());
    client.once('close', () => secure?.destroy());
    client.pipe(secure);
    secure.pipe(client);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'rdp handshake failed');
    if (err instanceof HandshakeError && socket.readyState === socket.OPEN) socket.send(err.pdu);
    closeAll();
  }
}
