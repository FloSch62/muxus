import fs from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import type { GnmiProfile } from '@muxus/shared';
import {
  presentedCertificate,
  serverName,
  trustedCertificateAuthorities,
  type PresentedCertificate,
} from '../remote-desktop/certificates.js';

/**
 * TLS for gNMI, done by Muxus rather than the gRPC layer so the certificate
 * can be pinned like an RDP certificate or an SSH host key, and so the same
 * code runs over a direct socket or an SSH gateway channel. gRPC needs
 * HTTP/2, negotiated with ALPN.
 */

async function readPem(file: string | undefined, what: string): Promise<Buffer | undefined> {
  if (!file) return undefined;
  try {
    return await fs.readFile(file);
  } catch (err) {
    throw new Error(`Could not read the ${what} ${file}: ${(err as Error).message}`);
  }
}

export interface GnmiTlsSocket {
  socket: tls.TLSSocket;
  certificate: PresentedCertificate | undefined;
}

export async function upgradeGnmiTls(stream: Duplex, profile: GnmiProfile): Promise<GnmiTlsSocket> {
  const [ca, cert, key] = await Promise.all([
    readPem(profile.caFile, 'CA certificate file'),
    readPem(profile.certFile, 'client certificate file'),
    readPem(profile.keyFile, 'client key file'),
  ]);
  const name = profile.tlsServerName ?? profile.host;
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const secure = tls.connect({
      socket: stream,
      servername: serverName(name),
      ALPNProtocols: ['h2'],
      // The verdict is ours: a chain that does not verify reaches the user
      // (or is waved through for skip-verify) instead of failing the handshake.
      rejectUnauthorized: false,
      ca: ca ? [ca] : trustedCertificateAuthorities(),
      ...(cert ? { cert } : {}),
      ...(key ? { key } : {}),
    });
    const onError = (err: Error) => {
      secure.destroy();
      reject(tlsFailure(err));
    };
    secure.once('secureConnect', () => {
      secure.off('error', onError);
      resolve(secure);
    });
    secure.once('error', onError);
  });
  if (socket.alpnProtocol !== 'h2') {
    socket.destroy();
    throw new Error('The device did not offer HTTP/2 over TLS (ALPN h2), which gNMI needs. Is this a gRPC port?');
  }
  return { socket, certificate: presentedCertificate(socket, name) };
}

function tlsFailure(err: Error): Error {
  const message = err.message;
  if (/wrong version number|packet length too long|unknown protocol/i.test(message)) {
    return new Error('The device did not answer with TLS. If it serves gNMI without encryption, set the host to plain text.');
  }
  if (/alert number 116|certificate required/i.test(message)) {
    return new Error('The device requires a client certificate (mutual TLS). Add one in the host settings.');
  }
  return new Error(`TLS handshake failed: ${message}`);
}
