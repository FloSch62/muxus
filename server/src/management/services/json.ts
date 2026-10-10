import type { FieldDef, MessageDef, ProtoMessage } from '../gnmi/protobuf.js';

/**
 * The JSON form of protobuf messages that travels between the renderer and
 * the backend for gNOI and gNSI: proto field names, enums by name, bytes as
 * base64, 64-bit integers as numbers while exact and decimal strings beyond.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export class ProtoJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtoJsonError';
  }
}

function enumNumber(field: FieldDef, value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && field.enumValues && value in field.enumValues) return field.enumValues[value]!;
  throw new ProtoJsonError(`${field.name}: ${JSON.stringify(value)} is not a valid value`);
}

function bigint(field: FieldDef, value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new ProtoJsonError(`${field.name}: ${JSON.stringify(value)} is not an integer`);
}

function scalarToProto(field: FieldDef, value: unknown): unknown {
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') throw new ProtoJsonError(`${field.name} must be text`);
      return value;
    case 'bytes':
      if (typeof value !== 'string') throw new ProtoJsonError(`${field.name} must be base64 text`);
      return Buffer.from(value, 'base64');
    case 'bool':
      return value === true;
    case 'int64':
    case 'uint64':
      return bigint(field, value);
    case 'enum':
      return enumNumber(field, value);
    case 'int32':
    case 'uint32':
    case 'double':
    case 'float': {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) throw new ProtoJsonError(`${field.name} must be a number`);
      return number;
    }
    default:
      return value;
  }
}

/** JSON from the renderer → the message object the codec encodes. Unknown keys are refused. */
export function jsonToProto(def: MessageDef, value: unknown): ProtoMessage {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ProtoJsonError(`${def.name} must be an object`);
  const out: ProtoMessage = {};
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!def.fields.some((field) => field.name === key)) throw new ProtoJsonError(`${def.name} has no field ${key}`);
  }
  for (const field of def.fields) {
    const raw = input[field.name];
    if (raw === undefined || raw === null) continue;
    if (field.type === 'map') {
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new ProtoJsonError(`${field.name} must be an object`);
      out[field.name] = Object.fromEntries(Object.entries(raw).map(([key, entry]) => [key, String(entry as string)]));
      continue;
    }
    const convert = (item: unknown) => (field.type === 'message' ? jsonToProto(field.message!(), item) : scalarToProto(field, item));
    if (field.repeated) {
      if (!Array.isArray(raw)) throw new ProtoJsonError(`${field.name} must be a list`);
      out[field.name] = raw.map(convert);
    } else {
      out[field.name] = convert(raw);
    }
  }
  return out;
}

function scalarToJson(field: FieldDef, value: unknown): JsonValue {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (field.type === 'enum' && typeof value === 'number' && field.enumValues) {
    const name = Object.entries(field.enumValues).find(([, number]) => number === value)?.[0];
    return name ?? value;
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

/** A decoded message → JSON for the renderer. */
export function protoToJson(def: MessageDef, message: ProtoMessage): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of def.fields) {
    const value = message[field.name];
    if (value === undefined) continue;
    if (field.type === 'map') {
      out[field.name] = value as Record<string, string>;
      continue;
    }
    const convert = (item: unknown): JsonValue =>
      field.type === 'message' ? protoToJson(field.message!(), item as ProtoMessage) : scalarToJson(field, item);
    out[field.name] = field.repeated ? (value as unknown[]).map(convert) : convert(value);
  }
  return out;
}
