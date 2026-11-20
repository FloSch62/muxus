import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeImportedText, MAX_SHARED_SESSIONS_BYTES } from '@muxus/shared';
import { trustedCertificateAuthorities } from '../remote-desktop/certificates.js';
import { HttpProblem } from '../util/errors.js';

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Where a shared session list is read from: a web address, or a file on this computer or a share. */
export type SharedSessionsLocation = { kind: 'url'; url: URL } | { kind: 'file'; path: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Where a link points. Web addresses are http or https, and a password in
 * one is refused: it would be stored and backed up in plain text. Anything
 * else is a file: an absolute path, `~/…`, a `\\server\share` path or a
 * `file://` address.
 */
export function sharedSessionsLocation(value: string): SharedSessionsLocation {
  const text = value.trim();
  if (SCHEME.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new HttpProblem(400, 'That link is not a valid address.');
    }
    if (url.protocol === 'file:') {
      try {
        return { kind: 'file', path: fileURLToPath(url) };
      } catch {
        throw new HttpProblem(400, 'That file:// link does not name a file on this computer.');
      }
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new HttpProblem(400, 'Shared sessions are read from https:// or http:// links, or from a file.');
    }
    if (url.username || url.password) {
      throw new HttpProblem(400, 'A link with a user name or password in it is not supported.');
    }
    return { kind: 'url', url };
  }
  const expanded = text === '~' || /^~[\\/]/.test(text) ? path.join(os.homedir(), text.slice(1)) : text;
  if (!path.isAbsolute(expanded)) {
    throw new HttpProblem(400, 'Enter the full link, starting with https://, or the full path of the file.');
  }
  return { kind: 'file', path: path.normalize(expanded) };
}

/** The form a location is stored in: the address, or the path with `~` and `file://` resolved. */
export function storedSharedSessionsLocation(value: string): string {
  const location = sharedSessionsLocation(value);
  return location.kind === 'url' ? location.url.toString() : location.path;
}

interface Answer {
  status: number;
  statusText: string;
  location?: string;
  body?: Buffer;
}

function request(url: URL, signal: AbortSignal): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const options = {
      signal,
      headers: { accept: '*/*', 'user-agent': 'Muxus' },
    };
    const onResponse = (response: http.IncomingMessage) => {
      const answer = { status: response.statusCode ?? 0, statusText: response.statusMessage ?? '' };
      if (answer.status !== 200) {
        response.resume();
        resolve({ ...answer, location: response.headers.location });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_SHARED_SESSIONS_BYTES) {
          response.destroy(new HttpProblem(502, 'The shared sessions file is larger than 10 MB.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ ...answer, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    };
    // The operating system's authorities too: lab portals tend to use a company CA.
    const outgoing =
      url.protocol === 'https:'
        ? https.get(url, { ...options, ca: trustedCertificateAuthorities() }, onResponse)
        : http.get(url, options, onResponse);
    outgoing.on('error', reject);
  });
}

/** Why a link could not be read, without repeating the link: it is often personal. */
function fetchProblem(error: unknown, url: URL): HttpProblem {
  if (error instanceof HttpProblem) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT') {
    return new HttpProblem(502, `${url.host} did not answer within ${TIMEOUT_MS / 1000} seconds.`);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new HttpProblem(502, `${url.hostname} could not be found. Check the link and your network or VPN.`);
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new HttpProblem(502, `${url.host} could not be reached (${code}).`);
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) {
    return new HttpProblem(502, `The certificate of ${url.host} is not trusted (${code}).`);
  }
  const detail = error instanceof Error && error.message ? error.message : String(error);
  return new HttpProblem(502, `${url.host} could not be read: ${detail}`);
}

/** Why a file could not be read. Only its name is repeated, not the folders above it. */
function fileProblem(error: unknown, file: string): HttpProblem {
  if (error instanceof HttpProblem) return error;
  const name = path.basename(file);
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  const aborted = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  if (aborted || code === 'ETIMEDOUT') {
    return new HttpProblem(502, `${name} did not open within ${TIMEOUT_MS / 1000} seconds. Is the drive connected?`);
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new HttpProblem(502, `${name} was not found. Check the path, and that the drive or share is connected.`);
  }
  if (code === 'EACCES' || code === 'EPERM') return new HttpProblem(502, `${name} cannot be read: access is denied.`);
  if (code === 'EISDIR') return new HttpProblem(502, `${name} is a folder. Enter the path of the session list in it.`);
  const detail = error instanceof Error && error.message ? error.message : String(error);
  return new HttpProblem(502, `${name} could not be read: ${detail}`);
}

async function readSharedSessionsFile(file: string): Promise<string> {
  // A share that went away can hang rather than fail.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const info = await stat(file);
    if (info.isDirectory()) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
    if (info.size > MAX_SHARED_SESSIONS_BYTES) {
      throw new HttpProblem(502, 'The shared sessions file is larger than 10 MB.');
    }
    return decodeImportedText(await readFile(file, { signal }));
  } catch (error) {
    throw fileProblem(error, file);
  }
}

/** Read the text of a shared session list: a file, or a web address with its redirects followed. */
export async function fetchSharedSessions(value: string): Promise<string> {
  const location = sharedSessionsLocation(value);
  if (location.kind === 'file') return readSharedSessionsFile(location.path);
  let url = location.url;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let answer: Answer;
    try {
      answer = await request(url, signal);
    } catch (error) {
      throw fetchProblem(error, url);
    }
    if (answer.body) return decodeImportedText(answer.body);
    if (answer.status >= 300 && answer.status < 400 && answer.location) {
      // A web address may only lead to another one, never to a file here.
      const next = sharedSessionsLocation(new URL(answer.location, url).toString());
      if (next.kind !== 'url') throw new HttpProblem(502, `${url.host} redirects to a file, which is not followed.`);
      url = next.url;
      continue;
    }
    throw new HttpProblem(
      502,
      `${url.host} answered ${answer.status}${answer.statusText ? ` ${answer.statusText}` : ''}.`,
    );
  }
  throw new HttpProblem(502, 'The link redirects too many times.');
}
