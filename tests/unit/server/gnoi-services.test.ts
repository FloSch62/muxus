import { createHash } from 'node:crypto';
import http2 from 'node:http2';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GRPC_METHODS } from '../../../shared/src/management.js';
import { GnmiClient } from '../../../server/src/management/gnmi/client.js';
import { frameMessage, GrpcCode, GrpcFrameDecoder } from '../../../server/src/management/gnmi/grpc.js';
import { decodeMessage, encodeMessage } from '../../../server/src/management/gnmi/protobuf.js';
import { FileGetResponse, FilePutRequest, GNOI_MESSAGES, HASH_METHOD } from '../../../server/src/management/services/gnoi.js';
import { ReflectionRequest, ReflectionResponse } from '../../../server/src/management/services/gnsi.js';
import { jsonToProto, ProtoJsonError, protoToJson } from '../../../server/src/management/services/json.js';
import { methodDef } from '../../../server/src/management/services/registry.js';
import { downloadFile, FileUpload, listServices } from '../../../server/src/management/services/transfer.js';

interface Call {
  path: string;
  stream: http2.ServerHttp2Stream;
  requests: Buffer[];
  ended: Promise<void>;
}

/** A gRPC target over plaintext HTTP/2 that answers whatever the test tells it to. */
async function fakeTarget(handle: (call: Call) => void) {
  const server = http2.createServer();
  const calls: Call[] = [];
  server.on('stream', (stream, headers) => {
    const requests: Buffer[] = [];
    const decoder = new GrpcFrameDecoder();
    stream.on('data', (chunk: Buffer) => requests.push(...decoder.push(chunk)));
    const ended = new Promise<void>((resolve) => stream.on('end', resolve));
    const call: Call = { path: String(headers[':path']), stream, requests, ended };
    calls.push(call);
    handle(call);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const client = await GnmiClient.connect({ socket, authority: `leaf1:${port}`, secure: false });
  cleanup.push(() => client.close(), () => server.close());
  return { client, calls };
}

function reply(stream: http2.ServerHttp2Stream, messages: Buffer[], status = 0, message?: string) {
  stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
  stream.on('wantTrailers', () =>
    stream.sendTrailers({ 'grpc-status': String(status), ...(message ? { 'grpc-message': encodeURIComponent(message) } : {}) }),
  );
  for (const payload of messages) stream.write(frameMessage(payload));
  stream.end();
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup) step();
  cleanup = [];
});

describe('gNOI/gNSI JSON mapping', () => {
  const ping = methodDef(GRPC_METHODS.ping)!;

  it('turns renderer JSON into codec values and back', () => {
    const message = jsonToProto(ping.request, {
      destination: '10.0.0.2',
      count: 3,
      interval: '1000000000',
      l3protocol: 'IPV4',
      network_instance: 'mgmt',
      do_not_resolve: true,
    });
    expect(message).toEqual({
      destination: '10.0.0.2',
      count: 3,
      interval: 1_000_000_000n,
      l3protocol: 1,
      network_instance: 'mgmt',
      do_not_resolve: true,
    });
    const decoded = decodeMessage(ping.request, encodeMessage(ping.request, message));
    expect(protoToJson(ping.request, decoded)).toMatchObject({ destination: '10.0.0.2', interval: 1_000_000_000, l3protocol: 'IPV4' });
  });

  it('keeps 64-bit values exact and bytes as base64', () => {
    const response = protoToJson(GNOI_MESSAGES.TimeResponse, { time: 1_760_000_000_123_456_789n });
    expect(response.time).toBe('1760000000123456789');
    const file = protoToJson(FileGetResponse, { contents: Buffer.from('hello') });
    expect(file.contents).toBe(Buffer.from('hello').toString('base64'));
  });

  it('refuses fields and enum values the message does not have', () => {
    expect(() => jsonToProto(ping.request, { destination: 'x', ttl: 4 })).toThrow(ProtoJsonError);
    expect(() => jsonToProto(ping.request, { l3protocol: 'IPX' })).toThrow(/not a valid value/);
    expect(() => jsonToProto(ping.request, { interval: '1s' })).toThrow(/not an integer/);
  });

  it('knows every method the renderer may call, and nothing else', () => {
    for (const path of Object.values(GRPC_METHODS)) expect(methodDef(path), path).toBeDefined();
    expect(methodDef(GRPC_METHODS.authzRotate)?.kind).toBe('bidi');
    expect(methodDef(GRPC_METHODS.ping)?.kind).toBe('server-stream');
    expect(methodDef('/gnoi.file.File/Put')).toBeUndefined();
    expect(methodDef('/gnmi.gNMI/Set')).toBeUndefined();
  });
});

describe('gNOI file transfers', () => {
  it('downloads a file and checks it against the hash the device sends', async () => {
    const parts = [Buffer.alloc(70_000, 1), Buffer.from('tail')];
    const whole = Buffer.concat(parts);
    const target = await fakeTarget((call) => {
      void call.ended.then(() =>
        reply(call.stream, [
          ...parts.map((contents) => encodeMessage(FileGetResponse, { contents })),
          encodeMessage(FileGetResponse, { hash: { method: HASH_METHOD.SHA512, hash: createHash('sha512').update(whole).digest() } }),
        ]),
      );
    });
    const received: Buffer[] = [];
    const result = await downloadFile(target.client, '/tmp/x', (chunk) => received.push(chunk));
    expect(result).toEqual({ size: whole.length, verified: true, hashMethod: 'sha512' });
    expect(Buffer.concat(received).equals(whole)).toBe(true);
    expect(target.calls[0]!.path).toBe('/gnoi.file.File/Get');
  });

  it('fails a download whose content does not match the hash', async () => {
    const target = await fakeTarget((call) => {
      void call.ended.then(() =>
        reply(call.stream, [
          encodeMessage(FileGetResponse, { contents: Buffer.from('corrupted') }),
          encodeMessage(FileGetResponse, { hash: { method: HASH_METHOD.SHA256, hash: createHash('sha256').update('original').digest() } }),
        ]),
      );
    });
    await expect(downloadFile(target.client, '/tmp/x', () => undefined)).rejects.toMatchObject({ code: GrpcCode.DATA_LOSS });
  });

  it('uploads in chunks and ends with the SHA-256 of what it sent', async () => {
    const target = await fakeTarget((call) => {
      void call.ended.then(() => reply(call.stream, []));
    });
    const content = Buffer.alloc(150_000, 7);
    const upload = new FileUpload(target.client, '/tmp/up.bin', 644);
    await upload.write(content.subarray(0, 100_000));
    await upload.write(content.subarray(100_000));
    expect(await upload.finish()).toBe(content.length);

    const requests = target.calls[0]!.requests.map((message) => decodeMessage(FilePutRequest, message));
    expect(requests[0]).toEqual({ open: { remote_file: '/tmp/up.bin', permissions: 644 } });
    const chunks = requests.slice(1, -1).map((request) => request.contents as Buffer);
    expect(chunks.every((chunk) => chunk.length <= 64 * 1024)).toBe(true);
    expect(Buffer.concat(chunks).equals(content)).toBe(true);
    expect(requests.at(-1)).toEqual({ hash: { method: HASH_METHOD.SHA256, hash: createHash('sha256').update(content).digest() } });
  });
});

describe('gRPC server reflection', () => {
  it('falls back to v1 when the device lacks v1alpha', async () => {
    const target = await fakeTarget((call) => {
      if (call.path.includes('v1alpha')) {
        reply(call.stream, [], GrpcCode.UNIMPLEMENTED, 'unknown service');
        return;
      }
      call.stream.on('data', () =>
        reply(call.stream, [
          encodeMessage(ReflectionResponse, { list_services_response: { service: [{ name: 'gnoi.system.System' }, { name: 'gnmi.gNMI' }] } }),
        ]),
      );
    });
    expect(await listServices(target.client)).toEqual(['gnmi.gNMI', 'gnoi.system.System']);
    expect(target.calls.map((call) => call.path)).toEqual([
      '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
      '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
    ]);
    expect(decodeMessage(ReflectionRequest, target.calls[1]!.requests[0]!)).toEqual({ list_services: '*' });
  });

  it('reports nothing when the device offers no reflection', async () => {
    const target = await fakeTarget((call) => reply(call.stream, [], GrpcCode.UNIMPLEMENTED));
    expect(await listServices(target.client)).toBeUndefined();
  });
});
