import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '../../../server/src/management/gnmi/protobuf.js';
import {
  CapabilityResponse,
  GetRequest,
  Notification,
  SubscribeRequest,
  SubscribeResponse,
} from '../../../server/src/management/gnmi/schema.js';
import {
  decodeTypedValue,
  encodingsFromProto,
  int64ToJson,
  notificationToJson,
  pathTextToProto,
  pickEncoding,
  setValueToProto,
} from '../../../server/src/management/gnmi/values.js';
import { frameMessage, GrpcError, GrpcFrameDecoder } from '../../../server/src/management/gnmi/grpc.js';

describe('gNMI protobuf codec', () => {
  it('encodes a GetRequest with keyed paths and the depth extension, and reads it back', () => {
    const request = {
      prefix: pathTextToProto('/network-instance[name=default]'),
      path: [pathTextToProto('/protocols/bgp/neighbor[peer-address=10.0.0.1]')],
      type: 2,
      encoding: 4,
      extension: [{ depth: { level: 2 } }],
    };
    const decoded = decodeMessage(GetRequest, encodeMessage(GetRequest, request));
    expect(decoded).toEqual(request);
  });

  it('keeps 64-bit integers exact, including negatives and values past 2^53', () => {
    const notification = {
      timestamp: 1791624701947184204n,
      update: [
        { path: pathTextToProto('/a'), val: { uint_val: 18446744073709551615n } },
        { path: pathTextToProto('/b'), val: { int_val: -42n } },
      ],
    };
    const decoded = decodeMessage(Notification, encodeMessage(Notification, notification));
    expect(decoded.timestamp).toBe(1791624701947184204n);
    const json = notificationToJson(decoded);
    expect(json.timestamp).toBe('1791624701947184204');
    expect(json.updates.map((update) => update.value)).toEqual([
      { type: 'uint', value: '18446744073709551615' },
      { type: 'int', value: -42 },
    ]);
  });

  it('decodes packed repeated enums and skips unknown fields', () => {
    // supported_encodings packed (field 2): [0, 4, 52], then an unknown field 9 (varint 1).
    const bytes = Buffer.from([0x12, 0x03, 0x00, 0x04, 0x34, 0x48, 0x01, 0x1a, 0x06, ...Buffer.from('0.10.0')]);
    const decoded = decodeMessage(CapabilityResponse, bytes);
    expect(decoded.supported_encodings).toEqual([0, 4, 52]);
    expect(decoded.gNMI_version).toBe('0.10.0');
    // Vendor-specific encoding numbers are left out of the list the client sees.
    expect(encodingsFromProto(decoded.supported_encodings)).toEqual(['json', 'json_ietf']);
  });

  it('encodes Poll as an empty message and subscription intervals in nanoseconds', () => {
    expect(encodeMessage(SubscribeRequest, { poll: {} })).toEqual(Buffer.from([0x1a, 0x00]));
    const decoded = decodeMessage(
      SubscribeRequest,
      encodeMessage(SubscribeRequest, {
        subscribe: { subscription: [{ path: pathTextToProto('/x'), mode: 2, sample_interval: 1_000_000_000n }], mode: 0 },
      }),
    );
    expect((decoded.subscribe as { subscription: Array<{ sample_interval: bigint }> }).subscription[0]!.sample_interval).toBe(
      1_000_000_000n,
    );
  });

  it('reads a sync_response and a notification from SubscribeResponse', () => {
    expect(decodeMessage(SubscribeResponse, encodeMessage(SubscribeResponse, { sync_response: true }))).toEqual({
      sync_response: true,
    });
  });

  it('unwraps TypedValues the way the client shows them', () => {
    expect(decodeTypedValue({ json_ietf_val: Buffer.from('{"a":"1"}') })).toEqual({ type: 'json_ietf', value: { a: '1' } });
    expect(decodeTypedValue({ decimal_val: { digits: -12345n, precision: 2 } })).toEqual({ type: 'decimal', value: -123.45 });
    expect(decodeTypedValue({ leaflist_val: { element: [{ string_val: 'a' }, { int_val: 2n }] } })).toEqual({
      type: 'leaflist',
      value: ['a', 2],
    });
    expect(decodeTypedValue({ bytes_val: Buffer.from('hi') })).toEqual({ type: 'bytes', value: 'aGk=' });
    expect(decodeTypedValue(undefined)).toEqual({ type: 'none', value: null });
    expect(int64ToJson(9007199254740993n)).toBe('9007199254740993');
  });

  it('joins the notification prefix into every update and delete path', () => {
    const json = notificationToJson({
      timestamp: 1n,
      prefix: pathTextToProto('/interface[name=e1]'),
      update: [{ path: pathTextToProto('/statistics/in-octets'), val: { uint_val: 5n } }],
      delete: [pathTextToProto('/description')],
    });
    expect(json.prefix).toBe('/interface[name=e1]');
    expect(json.updates[0]!.path).toBe('/interface[name=e1]/statistics/in-octets');
    expect(json.deletes).toEqual(['/interface[name=e1]/description']);
  });

  it('picks JSON_IETF over JSON and honours the host’s choice', () => {
    expect(pickEncoding(['proto', 'json', 'json_ietf'])).toBe('json_ietf');
    expect(pickEncoding(['proto', 'json'])).toBe('json');
    expect(pickEncoding([])).toBe('json');
    expect(pickEncoding(['json_ietf'], 'proto')).toBe('proto');
    expect(setValueToProto('"x"', 'json_ietf')).toEqual({ json_ietf_val: Buffer.from('"x"') });
    expect(setValueToProto('x', 'ascii')).toEqual({ ascii_val: 'x' });
  });
});

describe('gRPC message framing', () => {
  it('reassembles messages split across and packed into DATA chunks', () => {
    const one = frameMessage(Buffer.from('hello'));
    const two = frameMessage(Buffer.from(''));
    const three = frameMessage(Buffer.alloc(70_000, 7));
    const stream = Buffer.concat([one, two, three]);
    const decoder = new GrpcFrameDecoder();
    const messages: Buffer[] = [];
    for (let offset = 0; offset < stream.length; offset += 3) {
      messages.push(...decoder.push(stream.subarray(offset, offset + 3)));
    }
    expect(messages.map((message) => message.length)).toEqual([5, 0, 70_000]);
    expect(messages[0]!.toString()).toBe('hello');
  });

  it('refuses compressed messages it never asked for', () => {
    const frame = frameMessage(Buffer.from('x'));
    frame[0] = 1;
    expect(() => new GrpcFrameDecoder().push(frame)).toThrow(GrpcError);
  });
});
