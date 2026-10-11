import {
  formatGnmiPath,
  joinGnmiPaths,
  parseGnmiPath,
  type GnmiEncoding,
  type GnmiModel,
  type GnmiNotification,
  type GnmiPath,
  type GnmiValue,
} from '@muxus/shared';
import type { ProtoMessage } from './protobuf.js';
import { ENCODING } from './schema.js';

/** Conversions between gNMI protobuf messages and the JSON the client sees. */

/** A decoded proto3 string field: absent reads as ''. */
export function protoString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function pathToProto(path: GnmiPath): ProtoMessage {
  return {
    ...(path.origin ? { origin: path.origin } : {}),
    elem: path.elems.map((elem) => ({ name: elem.name, ...(elem.keys ? { key: elem.keys } : {}) })),
  };
}

export function pathTextToProto(text: string): ProtoMessage {
  return pathToProto(parseGnmiPath(text));
}

export function pathFromProto(message: ProtoMessage | undefined): GnmiPath {
  if (!message) return { elems: [] };
  const elems = (message.elem as ProtoMessage[] | undefined)?.map((elem) => {
    const keys = elem.key as Record<string, string> | undefined;
    return { name: protoString(elem.name), ...(keys && Object.keys(keys).length ? { keys } : {}) };
  });
  // Pre-0.4 targets send plain string elements.
  const legacy = (message.element as string[] | undefined)?.map((name) => ({ name }));
  const origin = typeof message.origin === 'string' && message.origin ? message.origin : undefined;
  return { ...(origin ? { origin } : {}), elems: elems ?? legacy ?? [] };
}

/** A 64-bit integer as a number while it is exact, as a decimal string beyond. */
export function int64ToJson(value: unknown): number | string {
  if (typeof value !== 'bigint') return Number(value ?? 0);
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
}

function parseJson(bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function decodeTypedValue(value: ProtoMessage | undefined): GnmiValue {
  if (!value) return { type: 'none', value: null };
  if ('json_ietf_val' in value) return { type: 'json_ietf', value: parseJson(value.json_ietf_val as Buffer) };
  if ('json_val' in value) return { type: 'json', value: parseJson(value.json_val as Buffer) };
  if ('string_val' in value) return { type: 'string', value: value.string_val };
  if ('int_val' in value) return { type: 'int', value: int64ToJson(value.int_val) };
  if ('uint_val' in value) return { type: 'uint', value: int64ToJson(value.uint_val) };
  if ('bool_val' in value) return { type: 'bool', value: value.bool_val };
  if ('double_val' in value) return { type: 'double', value: value.double_val };
  if ('float_val' in value) return { type: 'float', value: value.float_val };
  if ('ascii_val' in value) return { type: 'ascii', value: value.ascii_val };
  if ('bytes_val' in value) return { type: 'bytes', value: (value.bytes_val as Buffer).toString('base64') };
  if ('proto_bytes' in value) return { type: 'proto', value: (value.proto_bytes as Buffer).toString('base64') };
  if ('decimal_val' in value) {
    const decimal = value.decimal_val as ProtoMessage;
    const digits = BigInt((decimal.digits as bigint | undefined) ?? 0n);
    const precision = Number(decimal.precision ?? 0);
    const negative = digits < 0n;
    const text = (negative ? -digits : digits).toString().padStart(precision + 1, '0');
    const whole = precision ? `${text.slice(0, -precision)}.${text.slice(-precision)}` : text;
    return { type: 'decimal', value: Number(`${negative ? '-' : ''}${whole}`) };
  }
  if ('leaflist_val' in value) {
    const elements = ((value.leaflist_val as ProtoMessage).element as ProtoMessage[] | undefined) ?? [];
    return { type: 'leaflist', value: elements.map((element) => decodeTypedValue(element).value) };
  }
  if ('any_val' in value) {
    const any = value.any_val as ProtoMessage;
    return {
      type: 'any',
      value: { typeUrl: any.type_url ?? '', value: ((any.value as Buffer | undefined) ?? Buffer.alloc(0)).toString('base64') },
    };
  }
  return { type: 'none', value: null };
}

/** The deprecated Update.value of pre-TypedValue targets. */
function decodeLegacyValue(value: ProtoMessage): GnmiValue {
  const bytes = (value.value as Buffer | undefined) ?? Buffer.alloc(0);
  const type = Number(value.type ?? 0);
  if (type === ENCODING.json || type === ENCODING.json_ietf) {
    return { type: type === ENCODING.json ? 'json' : 'json_ietf', value: parseJson(bytes) };
  }
  if (type === ENCODING.ascii) return { type: 'ascii', value: bytes.toString('utf8') };
  return { type: 'bytes', value: bytes.toString('base64') };
}

export function notificationToJson(message: ProtoMessage): GnmiNotification {
  const prefix = message.prefix ? pathFromProto(message.prefix as ProtoMessage) : undefined;
  const absolute = (path: ProtoMessage | undefined) => formatGnmiPath(joinGnmiPaths(prefix, pathFromProto(path)));
  const updates = ((message.update as ProtoMessage[] | undefined) ?? []).map((update) => ({
    path: absolute(update.path as ProtoMessage | undefined),
    value: update.val
      ? decodeTypedValue(update.val as ProtoMessage)
      : update.value
        ? decodeLegacyValue(update.value as ProtoMessage)
        : { type: 'none' as const, value: null },
    ...(update.duplicates ? { duplicates: Number(update.duplicates) } : {}),
  }));
  return {
    timestamp: String((message.timestamp as bigint | undefined) ?? 0n),
    ...(prefix && (prefix.elems.length || prefix.origin) ? { prefix: formatGnmiPath(prefix) } : {}),
    ...(message.atomic ? { atomic: true } : {}),
    updates,
    deletes: ((message.delete as ProtoMessage[] | undefined) ?? []).map((path) => absolute(path)),
  };
}

const ENCODING_NAMES = new Map<number, GnmiEncoding>(
  Object.entries(ENCODING).map(([name, value]) => [value, name as GnmiEncoding]),
);

/** Standard encodings the device lists; vendor-specific numbers are left out. */
export function encodingsFromProto(values: unknown): GnmiEncoding[] {
  if (!Array.isArray(values)) return [];
  const names: GnmiEncoding[] = [];
  for (const value of values) {
    const name = ENCODING_NAMES.get(Number(value));
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function modelsFromProto(values: unknown): GnmiModel[] {
  if (!Array.isArray(values)) return [];
  return (values as ProtoMessage[]).map((model) => ({
    name: protoString(model.name),
    organization: protoString(model.organization),
    version: protoString(model.version),
  }));
}

/** The encoding to request: the profile's choice, else the best one offered. */
export function pickEncoding(offered: GnmiEncoding[], preferred?: GnmiEncoding): GnmiEncoding {
  if (preferred) return preferred;
  for (const candidate of ['json_ietf', 'json'] as const) if (offered.includes(candidate)) return candidate;
  // A device that lists nothing is assumed to speak the default, JSON.
  return offered[0] ?? 'json';
}

/** A Set value as a TypedValue. */
export function setValueToProto(value: string, encoding: 'json_ietf' | 'json' | 'ascii'): ProtoMessage {
  if (encoding === 'ascii') return { ascii_val: value };
  return { [`${encoding}_val`]: Buffer.from(value, 'utf8') };
}
