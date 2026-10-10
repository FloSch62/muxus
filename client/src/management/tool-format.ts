import type { GrpcJson } from '@muxus/shared';

/** Reading and writing the shapes gNOI and gNSI use, for the operations and security tools. */

/**
 * gNOI reports permissions as their octal digits written in decimal (644),
 * not as a mode number; `rw-r--r--` either way.
 */
export function permissionString(value: number | undefined): string {
  if (value === undefined) return '';
  const digits = String(value).padStart(3, '0').slice(-3);
  if (!/^[0-7]{3}$/.test(digits)) return String(value);
  return digits
    .split('')
    .map((digit) => {
      const bits = Number(digit);
      return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
    })
    .join('');
}

const KEY_TYPES: Record<string, string> = {
  'ssh-ed25519': 'KEY_TYPE_ED25519',
  'ecdsa-sha2-nistp256': 'KEY_TYPE_ECDSA_P_256',
  'ecdsa-sha2-nistp384': 'KEY_TYPE_ECDSA_P_384',
  'ecdsa-sha2-nistp521': 'KEY_TYPE_ECDSA_P_521',
  'ssh-rsa': 'KEY_TYPE_RSA_2048',
};

export interface ParsedKey {
  type: string;
  /** The base64 key data, as in the authorized_keys line. */
  blob: string;
  comment: string;
  keyType: string;
}

/** The modulus size of an ssh-rsa key blob: string type, mpint e, mpint n. */
function rsaBits(blob: string): number {
  const bytes = Uint8Array.from(atob(blob), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const next = () => {
    const length = view.getUint32(offset);
    const start = offset + 4;
    offset = start + length;
    return bytes.subarray(start, offset);
  };
  next();
  next();
  const modulus = next();
  const leadingZero = modulus[0] === 0 ? 1 : 0;
  return (modulus.length - leadingZero) * 8;
}

/** OpenSSH public key lines; options before the key type are not supported here. */
export function parseAuthorizedKeys(text: string): { keys: ParsedKey[]; problem?: string } {
  const keys: ParsedKey[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [type = '', blob = '', ...comment] = line.split(/\s+/);
    let keyType = KEY_TYPES[type];
    if (!keyType) return { keys, problem: `Line ${index + 1}: ${type || 'the key'} is not a key type gNSI can carry.` };
    if (!/^[A-Za-z0-9+/]+=*$/.test(blob)) return { keys, problem: `Line ${index + 1}: the key data is not base64.` };
    if (type === 'ssh-rsa') {
      let bits = 0;
      try {
        bits = rsaBits(blob);
      } catch {
        return { keys, problem: `Line ${index + 1}: the RSA key data is damaged.` };
      }
      if (bits !== 2048 && bits !== 3072 && bits !== 4096) {
        return { keys, problem: `Line ${index + 1}: gNSI carries RSA keys of 2048, 3072 or 4096 bits, not ${bits}.` };
      }
      keyType = `KEY_TYPE_RSA_${bits}`;
    }
    keys.push({ type, blob, comment: comment.join(' '), keyType });
  }
  return { keys };
}

/** One accounting record, flattened for the table. */
export interface AccountingRecord {
  key: string;
  /** Milliseconds since the epoch. */
  at: number;
  user: string;
  role?: string;
  service: string;
  action: string;
  authz?: 'permit' | 'deny' | 'error';
  authzDetail?: string;
  remote?: string;
  session?: string;
  arrived: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

const SERVICE_NAMES: Record<string, string> = {
  CMD_SERVICE_TYPE_SHELL: 'shell',
  CMD_SERVICE_TYPE_CLI: 'CLI',
  CMD_SERVICE_TYPE_WEBUI: 'web UI',
  CMD_SERVICE_TYPE_RESTCONF: 'RESTCONF',
  CMD_SERVICE_TYPE_NETCONF: 'NETCONF',
  GRPC_SERVICE_TYPE_GNMI: 'gNMI',
  GRPC_SERVICE_TYPE_GNOI: 'gNOI',
  GRPC_SERVICE_TYPE_GNSI: 'gNSI',
  GRPC_SERVICE_TYPE_GRIBI: 'gRIBI',
  GRPC_SERVICE_TYPE_P4RT: 'P4Runtime',
};

let recordCounter = 0;

export function accountingRecord(message: GrpcJson): AccountingRecord {
  const session = (message.session_info ?? {}) as GrpcJson;
  const user = (session.user ?? {}) as GrpcJson;
  const timestamp = (message.timestamp ?? {}) as GrpcJson;
  const cmd = message.cmd_service as GrpcJson | undefined;
  const grpc = message.grpc_service as GrpcJson | undefined;
  const service = cmd ?? grpc ?? {};
  const authz = (service.authz ?? {}) as GrpcJson;
  const status = text(authz.status);
  const args = Array.isArray(cmd?.cmd_args) ? (cmd.cmd_args as string[]).join(' ') : '';
  return {
    key: `${++recordCounter}`,
    at: Number(timestamp.seconds ?? 0) * 1000 + Math.floor(Number(timestamp.nanos ?? 0) / 1e6),
    user: text(user.identity) || '—',
    role: text(user.role).replace(/^SYSTEM_ROLE_/, '').toLowerCase() || undefined,
    service: SERVICE_NAMES[text(service.service_type)] ?? (cmd ? 'command' : grpc ? 'gRPC' : '—'),
    action: cmd ? [text(cmd.cmd), args].filter(Boolean).join(' ') : grpc ? text(grpc.rpc_name) : text(session.status).replace(/^SESSION_STATUS_/, '').toLowerCase(),
    ...(status.endsWith('PERMIT') ? { authz: 'permit' as const } : status.endsWith('DENY') ? { authz: 'deny' as const } : status.endsWith('ERROR') ? { authz: 'error' as const } : {}),
    ...(text(authz.detail) ? { authzDetail: text(authz.detail) } : {}),
    ...(text(session.remote_address) ? { remote: text(session.remote_address) } : {}),
    ...(text(session.status) ? { session: text(session.status).replace(/^SESSION_STATUS_/, '').toLowerCase() } : {}),
    arrived: Date.now(),
  };
}
