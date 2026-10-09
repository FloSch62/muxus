/**
 * ssh:// and telnet:// links handed to the desktop app by a browser or
 * another program. ssh:// follows draft-ietf-secsh-scp-sftp-ssh-uri,
 * `ssh://[user[;fingerprint=…]@]host[:port][/]`, and telnet:// follows
 * RFC 4248, `telnet://[user@]host[:port][/]`.
 */

export type ConnectionLinkScheme = 'ssh' | 'telnet';

export const CONNECTION_LINK_SCHEMES: readonly ConnectionLinkScheme[] = ['ssh', 'telnet'];

export interface ConnectionLink {
  scheme: ConnectionLinkScheme;
  /** Percent-decoded; an IPv6 literal without its brackets. */
  host: string;
  /** Absent when the link leaves the default port to the host's settings. */
  port?: number;
  /** Telnet has no login of its own, so a telnet:// user is only advisory. */
  user?: string;
  /** ssh:// only: the host key the server must present, in canonical form. */
  hostKeyFingerprint?: string;
}

export type ConnectionLinkResult =
  | { ok: true; link: ConnectionLink }
  | { ok: false; error: string };

export const CONNECTION_LINK_MAX_LENGTH = 2048;

// Hosts and users can reach a ProxyCommand shell through %h and %r, so like
// OpenSSH for command-line hosts only plain names are accepted from outside.
export const SSH_USER_PATTERN = /^(?!-)[\w.@+-]+$/;
export const SSH_HOSTNAME_PATTERN = /^(?![-.])[A-Za-z0-9._-]+$/;
export const IPV6_ADDRESS_PATTERN = /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?$/;

const MAX_HOST_LENGTH = 253;
const MAX_USER_LENGTH = 255;

const SHA256_FINGERPRINT = /^SHA256:([A-Za-z0-9+/_-]{43})=?$/i;
const MD5_FINGERPRINT = /^MD5:((?:[0-9a-f]{2}:){15}[0-9a-f]{2})$/i;
/** The draft's own form: key type, then the MD5 digest in dash-separated pairs. */
const DRAFT_FINGERPRINT = /^([a-z][a-z0-9.@-]*?)-((?:[0-9a-f]{2}-){15}[0-9a-f]{2})$/i;
const TYPED_MD5_FINGERPRINT = /^([a-z][a-z0-9.@-]*) (MD5:(?:[0-9a-f]{2}:){15}[0-9a-f]{2})$/i;

/**
 * Canonical host key fingerprint, or undefined when the value is not one:
 * `SHA256:<base64>` as `ssh-keygen -l` prints it (URL-safe base64 is
 * accepted too), `MD5:<hex pairs>`, or the draft's `<key type>-<hex pairs>`,
 * which keeps its key type as `<key type> MD5:<hex pairs>`, a form that is
 * accepted in turn.
 */
export function normalizeHostKeyFingerprint(value: string): string | undefined {
  const sha256 = SHA256_FINGERPRINT.exec(value);
  if (sha256) return `SHA256:${sha256[1]!.replaceAll('-', '+').replaceAll('_', '/')}`;
  const md5 = MD5_FINGERPRINT.exec(value);
  if (md5) return `MD5:${md5[1]!.toLowerCase()}`;
  const draft = DRAFT_FINGERPRINT.exec(value);
  if (draft) {
    return `${draft[1]!.toLowerCase()} MD5:${draft[2]!.toLowerCase().replaceAll('-', ':')}`;
  }
  const typed = TYPED_MD5_FINGERPRINT.exec(value);
  if (typed) return `${typed[1]!.toLowerCase()} MD5:${typed[2]!.slice(4).toLowerCase()}`;
  return undefined;
}

/** Whether a command-line argument is meant as a link rather than a file or switch. */
export function looksLikeConnectionLink(argument: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(argument) || /^(?:ssh|telnet):/i.test(argument);
}

function percentDecode(value: string): string | undefined {
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function quoted(value: string): string {
  return `“${value.length > 64 ? `${value.slice(0, 63)}…` : value}”`;
}

function failure(error: string): ConnectionLinkResult {
  return { ok: false, error };
}

/** Parse and validate one link. Nothing in it is trusted until this accepts it. */
export function parseConnectionLink(input: string): ConnectionLinkResult {
  const url = input.trim();
  if (url.length > CONNECTION_LINK_MAX_LENGTH) {
    return failure(`The link is longer than ${CONNECTION_LINK_MAX_LENGTH} characters.`);
  }
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  const scheme = schemeMatch?.[1]!.toLowerCase();
  if (scheme !== 'ssh' && scheme !== 'telnet') {
    return failure('Muxus opens only ssh:// and telnet:// links.');
  }
  // Raw spaces, quotes and control characters never belong in a URL.
  if (!url.startsWith('//', schemeMatch![0].length) || /[\s"<>\\^`{|}\p{Cc}]/u.test(url)) {
    return failure('The link is not a valid URL.');
  }

  const rest = url.slice(schemeMatch![0].length + 2);
  const queryAt = rest.search(/[?#]/);
  const hierarchy = queryAt < 0 ? rest : rest.slice(0, queryAt);
  let authorityEnd = hierarchy.indexOf('/');
  const lastAt = hierarchy.lastIndexOf('@');
  // A base64 fingerprint may carry an unescaped "/" before the "@".
  if (
    authorityEnd >= 0 &&
    lastAt > authorityEnd &&
    /;fingerprint=/i.test(hierarchy.slice(0, lastAt))
  ) {
    authorityEnd = hierarchy.indexOf('/', lastAt);
  }
  // A path, query or fragment has no meaning for either scheme and is ignored.
  const authority = authorityEnd < 0 ? hierarchy : hierarchy.slice(0, authorityEnd);

  const at = authority.lastIndexOf('@');
  const userinfo = at < 0 ? undefined : authority.slice(0, at);
  const hostPort = authority.slice(at + 1);

  let user: string | undefined;
  let hostKeyFingerprint: string | undefined;
  if (userinfo !== undefined) {
    const separator = userinfo.indexOf(';');
    const rawUser = separator < 0 ? userinfo : userinfo.slice(0, separator);
    if (separator >= 0 && scheme === 'telnet') {
      return failure('Telnet links take no connection parameters.');
    }
    if (rawUser.includes(':')) {
      return failure('Links with a password are not accepted. Muxus asks for the password instead.');
    }
    const decodedUser = percentDecode(rawUser);
    if (decodedUser === undefined) return failure('The link is not a valid URL.');
    if (decodedUser) {
      if (decodedUser.length > MAX_USER_LENGTH || !SSH_USER_PATTERN.test(decodedUser)) {
        return failure(`${quoted(decodedUser)} is not a valid user name.`);
      }
      user = decodedUser;
    }
    if (separator >= 0) {
      for (const parameter of userinfo.slice(separator + 1).split(/[;,]/)) {
        if (!parameter) continue;
        const equals = parameter.indexOf('=');
        const name = (equals < 0 ? parameter : parameter.slice(0, equals)).toLowerCase();
        // Connection parameters this client does not know are ignored, as the draft asks.
        if (name !== 'fingerprint') continue;
        if (hostKeyFingerprint !== undefined) {
          return failure('The link names more than one fingerprint.');
        }
        const value = percentDecode(parameter.slice(equals + 1));
        hostKeyFingerprint = value === undefined ? undefined : normalizeHostKeyFingerprint(value);
        if (!hostKeyFingerprint) {
          return failure('The fingerprint is not in the form SHA256:… that ssh-keygen -l prints.');
        }
      }
    }
  }

  let rawHost: string;
  let rawPort: string | undefined;
  let host: string | undefined;
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(hostPort);
  if (hostPort.startsWith('[') && !bracketed) {
    return failure(`${quoted(hostPort)} is not a valid host name.`);
  }
  if (bracketed) {
    rawHost = bracketed[1]!;
    rawPort = bracketed[2];
    // RFC 6874 writes an IPv6 zone's "%" as "%25".
    const literal = rawHost.replace(/%25/g, '%');
    if (IPV6_ADDRESS_PATTERN.test(literal)) host = literal;
  } else {
    const colon = hostPort.indexOf(':');
    rawHost = colon < 0 ? hostPort : hostPort.slice(0, colon);
    rawPort = colon < 0 ? undefined : hostPort.slice(colon + 1);
    const decoded = percentDecode(rawHost);
    if (decoded !== undefined && SSH_HOSTNAME_PATTERN.test(decoded)) host = decoded;
  }
  if (!rawHost) return failure('The link does not name a host.');
  if (!host || host.length > MAX_HOST_LENGTH) {
    return failure(`${quoted(percentDecode(rawHost) ?? rawHost)} is not a valid host name.`);
  }

  let port: number | undefined;
  // RFC 3986 allows an empty port, which means the default one.
  if (rawPort) {
    port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
    if (port < 1 || port > 65_535) return failure('The port must be a number from 1 to 65535.');
  }

  return {
    ok: true,
    link: {
      scheme,
      host,
      ...(port === undefined ? {} : { port }),
      ...(user === undefined ? {} : { user }),
      ...(hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint }),
    },
  };
}

/** The link as an ad-hoc `[user@]host[:port]` SSH target, bracketing IPv6 before a port. */
export function connectionLinkTarget(link: ConnectionLink): string {
  const host = link.port !== undefined && link.host.includes(':') ? `[${link.host}]` : link.host;
  return `${link.user ? `${link.user}@` : ''}${host}${link.port !== undefined ? `:${link.port}` : ''}`;
}
