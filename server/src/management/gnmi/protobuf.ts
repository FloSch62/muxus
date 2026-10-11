/**
 * Just enough protobuf for gNMI: a codec driven by hand-written message
 * descriptors (see schema.ts) instead of generated code or a runtime .proto
 * parser. 64-bit integers are bigints so counters survive past 2^53; bytes
 * are Buffers; maps are plain records; absent fields stay absent.
 */

export type ScalarType =
  | 'string'
  | 'bytes'
  | 'bool'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'enum'
  | 'double'
  | 'float';

export interface FieldDef {
  no: number;
  name: string;
  type: ScalarType | 'message' | 'map';
  /** Message fields: the nested descriptor (a thunk, for recursive types). */
  message?: () => MessageDef;
  repeated?: boolean;
  /** Enum fields: value names, so JSON can say `COLD` instead of `1`. */
  enumValues?: Readonly<Record<string, number>>;
}

export interface MessageDef {
  name: string;
  fields: FieldDef[];
}

export type ProtoMessage = Record<string, unknown>;

const WIRE_VARINT = 0;
const WIRE_64 = 1;
const WIRE_LEN = 2;
const WIRE_32 = 5;

const fieldIndex = new WeakMap<MessageDef, Map<number, FieldDef>>();

function fieldsByNumber(def: MessageDef): Map<number, FieldDef> {
  let index = fieldIndex.get(def);
  if (!index) {
    index = new Map(def.fields.map((field) => [field.no, field]));
    fieldIndex.set(def, index);
  }
  return index;
}

class Writer {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  bytes(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }

  raw(buffer: Buffer): void {
    this.chunks.push(buffer);
    this.size += buffer.length;
  }

  varint(value: bigint): void {
    let v = BigInt.asUintN(64, value);
    const out: number[] = [];
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) byte |= 0x80;
      out.push(byte);
    } while (v !== 0n);
    this.raw(Buffer.from(out));
  }

  tag(no: number, wire: number): void {
    this.varint(BigInt((no << 3) | wire));
  }

  lengthDelimited(no: number, payload: Buffer): void {
    this.tag(no, WIRE_LEN);
    this.varint(BigInt(payload.length));
    this.raw(payload);
  }
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string') return BigInt(value);
  throw new TypeError(`cannot encode ${typeof value} as an integer`);
}

function writeScalar(writer: Writer, field: FieldDef, value: unknown): void {
  switch (field.type) {
    case 'string':
      writer.lengthDelimited(field.no, Buffer.from(String(value), 'utf8'));
      return;
    case 'bytes':
      writer.lengthDelimited(field.no, Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array));
      return;
    case 'double': {
      writer.tag(field.no, WIRE_64);
      const buffer = Buffer.alloc(8);
      buffer.writeDoubleLE(Number(value));
      writer.raw(buffer);
      return;
    }
    case 'float': {
      writer.tag(field.no, WIRE_32);
      const buffer = Buffer.alloc(4);
      buffer.writeFloatLE(Number(value));
      writer.raw(buffer);
      return;
    }
    default:
      writer.tag(field.no, WIRE_VARINT);
      // int32/enum negatives are sign-extended to ten bytes, as protobuf does.
      writer.varint(toBigInt(value));
  }
}

function isDefault(field: FieldDef, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (field.repeated || field.type === 'message' || field.type === 'map') return false;
  // proto3 scalars at their default value are not sent.
  if (field.type === 'string') return value === '';
  if (field.type === 'bytes') return (value as Buffer).length === 0;
  if (field.type === 'bool') return value === false;
  if (field.type === 'double' || field.type === 'float') return value === 0;
  return toBigInt(value) === 0n;
}

export function encodeMessage(def: MessageDef, message: ProtoMessage): Buffer {
  const writer = new Writer();
  for (const field of def.fields) {
    const value = message[field.name];
    if (isDefault(field, value)) continue;
    if (field.type === 'map') {
      for (const [key, entry] of Object.entries(value as Record<string, string>)) {
        const inner = new Writer();
        inner.lengthDelimited(1, Buffer.from(key, 'utf8'));
        inner.lengthDelimited(2, Buffer.from(String(entry), 'utf8'));
        writer.lengthDelimited(field.no, inner.bytes());
      }
      continue;
    }
    const values = field.repeated ? (value as unknown[]) : [value];
    for (const item of values) {
      if (field.type === 'message') writer.lengthDelimited(field.no, encodeMessage(field.message!(), item as ProtoMessage));
      else writeScalar(writer, field, item);
    }
  }
  return writer.bytes();
}

class Reader {
  offset: number;

  constructor(
    readonly buffer: Buffer,
    start = 0,
    readonly end = buffer.length,
  ) {
    this.offset = start;
  }

  get done(): boolean {
    return this.offset >= this.end;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.offset >= this.end) throw new Error('truncated protobuf varint');
      const byte = this.buffer[this.offset++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error('malformed protobuf varint');
  }

  take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.end) throw new Error('truncated protobuf field');
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_64:
        this.take(8);
        return;
      case WIRE_LEN:
        this.take(Number(this.varint()));
        return;
      case WIRE_32:
        this.take(4);
        return;
      default:
        throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

function scalarFromVarint(type: ScalarType, raw: bigint): unknown {
  switch (type) {
    case 'bool':
      return raw !== 0n;
    case 'int64':
      return BigInt.asIntN(64, raw);
    case 'uint64':
      return BigInt.asUintN(64, raw);
    case 'int32':
    case 'enum':
      return Number(BigInt.asIntN(32, raw));
    case 'uint32':
      return Number(BigInt.asUintN(32, raw));
    default:
      throw new Error(`unexpected varint for ${type}`);
  }
}

function readScalar(reader: Reader, field: FieldDef, wire: number): unknown {
  switch (field.type) {
    case 'string':
      return reader.take(Number(reader.varint())).toString('utf8');
    case 'bytes':
      return Buffer.from(reader.take(Number(reader.varint())));
    case 'double':
      return reader.take(8).readDoubleLE(0);
    case 'float':
      return reader.take(4).readFloatLE(0);
    default:
      if (wire !== WIRE_VARINT) throw new Error(`unexpected wire type ${wire} for ${field.name}`);
      return scalarFromVarint(field.type as ScalarType, reader.varint());
  }
}

function decodeMapEntry(buffer: Buffer): [string, string] {
  const reader = new Reader(buffer);
  let key = '';
  let value = '';
  while (!reader.done) {
    const tag = reader.varint();
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire !== WIRE_LEN) {
      reader.skip(wire);
      continue;
    }
    const text = reader.take(Number(reader.varint())).toString('utf8');
    if (no === 1) key = text;
    else if (no === 2) value = text;
  }
  return [key, value];
}

function packable(type: FieldDef['type']): boolean {
  return type !== 'string' && type !== 'bytes' && type !== 'message' && type !== 'map';
}

export function decodeMessage(def: MessageDef, buffer: Buffer): ProtoMessage {
  const reader = new Reader(buffer);
  const out: ProtoMessage = {};
  const fields = fieldsByNumber(def);
  while (!reader.done) {
    const tag = reader.varint();
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    const field = fields.get(no);
    if (!field) {
      reader.skip(wire);
      continue;
    }
    if (field.type === 'map') {
      const [key, value] = decodeMapEntry(reader.take(Number(reader.varint())));
      const map = (out[field.name] ??= {}) as Record<string, string>;
      map[key] = value;
      continue;
    }
    if (field.type === 'message') {
      const decoded = decodeMessage(field.message!(), reader.take(Number(reader.varint())));
      if (field.repeated) ((out[field.name] ??= []) as unknown[]).push(decoded);
      else out[field.name] = decoded;
      continue;
    }
    if (field.repeated && wire === WIRE_LEN && packable(field.type)) {
      const packed = reader.take(Number(reader.varint()));
      const inner = new Reader(packed);
      const list = (out[field.name] ??= []) as unknown[];
      const innerWire = field.type === 'double' ? WIRE_64 : field.type === 'float' ? WIRE_32 : WIRE_VARINT;
      while (!inner.done) list.push(readScalar(inner, field, innerWire));
      continue;
    }
    const value = readScalar(reader, field, wire);
    if (field.repeated) ((out[field.name] ??= []) as unknown[]).push(value);
    else out[field.name] = value;
  }
  return out;
}
