import http2 from 'node:http2';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GnmiClient } from '../../../server/src/management/gnmi/client.js';
import { frameMessage, GrpcFrameDecoder } from '../../../server/src/management/gnmi/grpc.js';
import { decodeMessage, encodeMessage, type ProtoMessage } from '../../../server/src/management/gnmi/protobuf.js';
import {
  CapabilityResponse,
  GetRequest,
  GetResponse,
  SetRequest,
  SetResponse,
  SubscribeRequest,
  SubscribeResponse,
} from '../../../server/src/management/gnmi/schema.js';
import { pathTextToProto } from '../../../server/src/management/gnmi/values.js';

interface Call {
  path: string;
  headers: http2.IncomingHttpHeaders;
  stream: http2.ServerHttp2Stream;
  requests: Buffer[];
  onRequest?: (message: Buffer) => void;
}

/** A gNMI target over plaintext HTTP/2 that answers whatever the test tells it to. */
async function fakeTarget(handle: (call: Call) => void) {
  const server = http2.createServer();
  const calls: Call[] = [];
  server.on('stream', (stream, headers) => {
    const call: Call = { path: String(headers[':path']), headers, stream, requests: [] };
    calls.push(call);
    const decoder = new GrpcFrameDecoder();
    stream.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        call.requests.push(message);
        call.onRequest?.(message);
      }
    });
    handle(call);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const client = await GnmiClient.connect({ socket, authority: `leaf1:${port}`, secure: false });
  return { server, client, calls };
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

describe('gNMI client over HTTP/2', () => {
  it('sends credentials as metadata and reads capabilities', async () => {
    const target = await fakeTarget((call) => {
      call.stream.on('end', () =>
        reply(call.stream, [
          encodeMessage(CapabilityResponse, {
            supported_models: [{ name: 'openconfig-interfaces', organization: 'OpenConfig', version: '3.0.0' }],
            supported_encodings: [4, 0],
            gNMI_version: '0.10.0',
          }),
        ]),
      );
    });
    cleanup.push(() => target.client.close(), () => target.server.close());
    target.client.setCredentials('admin', 'secret');
    const capabilities = await target.client.capabilities();
    expect(capabilities).toMatchObject({
      version: '0.10.0',
      encodings: ['json_ietf', 'json'],
      models: [{ name: 'openconfig-interfaces', organization: 'OpenConfig', version: '3.0.0' }],
    });
    const call = target.calls[0]!;
    expect(call.path).toBe('/gnmi.gNMI/Capabilities');
    expect(call.headers['content-type']).toBe('application/grpc');
    expect(call.headers.te).toBe('trailers');
    expect(call.headers.username).toBe('admin');
    expect(call.headers.password).toBe('secret');
  });

  it('encodes Get with its options and turns gRPC errors into readable failures', async () => {
    const target = await fakeTarget((call) => {
      call.stream.on('end', () => {
        const request = decodeMessage(GetRequest, call.requests[0]!);
        if ((request.path as ProtoMessage[])[0]!.elem && JSON.stringify(request.path).includes('nope')) {
          reply(call.stream, [], 3, "Path not valid - unknown element 'nope'");
          return;
        }
        reply(call.stream, [
          encodeMessage(GetResponse, {
            notification: [
              {
                timestamp: 5n,
                update: [{ path: pathTextToProto('/system/name'), val: { json_ietf_val: Buffer.from('"leaf1"') } }],
              },
            ],
          }),
        ]);
      });
    });
    cleanup.push(() => target.client.close(), () => target.server.close());
    const result = await target.client.get(
      { op: 'gnmi-get', id: 'g', paths: ['/system/name'], type: 'state', depth: 2 },
      'json_ietf',
    );
    expect(result.notifications[0]!.updates[0]).toEqual({ path: '/system/name', value: { type: 'json_ietf', value: 'leaf1' } });
    const request = decodeMessage(GetRequest, target.calls[0]!.requests[0]!);
    expect(request).toMatchObject({ type: 2, encoding: 4, extension: [{ depth: { level: 2 } }] });
    await expect(
      target.client.get({ op: 'gnmi-get', id: 'g2', paths: ['/nope'], type: 'all' }, 'json_ietf'),
    ).rejects.toMatchObject({ codeName: 'INVALID_ARGUMENT', message: "Path not valid - unknown element 'nope'" });
  });

  it('sends Set with the commit-confirmed extension', async () => {
    const target = await fakeTarget((call) => {
      call.stream.on('end', () =>
        reply(call.stream, [
          encodeMessage(SetResponse, {
            timestamp: 7n,
            response: [{ path: pathTextToProto('/interface[name=e1]/description'), op: 3 }],
          }),
        ]),
      );
    });
    cleanup.push(() => target.client.close(), () => target.server.close());
    const result = await target.client.set({
      op: 'gnmi-set',
      id: 's',
      updates: [{ path: '/interface[name=e1]/description', value: '"uplink"', encoding: 'json_ietf' }],
      replaces: [],
      deletes: ['/interface[name=e2]'],
      commit: { action: 'commit', id: 'c1', rollbackSeconds: 60 },
    });
    expect(result.results).toEqual([{ path: '/interface[name=e1]/description', op: 'update' }]);
    expect(decodeMessage(SetRequest, target.calls[0]!.requests[0]!)).toMatchObject({
      delete: [{ elem: [{ name: 'interface', key: { name: 'e2' } }] }],
      update: [{ val: { json_ietf_val: Buffer.from('"uplink"') } }],
      extension: [{ commit: { id: 'c1', commit: { rollback_duration: { seconds: 60n } } } }],
    });
  });

  it('streams a subscription until it is cancelled', async () => {
    const target = await fakeTarget((call) => {
      call.onRequest = (message) => {
        const request = decodeMessage(SubscribeRequest, message);
        if (!request.subscribe) return;
        call.stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
        for (const value of [1n, 2n]) {
          call.stream.write(
            frameMessage(
              encodeMessage(SubscribeResponse, {
                update: { timestamp: value, update: [{ path: pathTextToProto('/c'), val: { uint_val: value } }] },
              }),
            ),
          );
        }
        call.stream.write(frameMessage(encodeMessage(SubscribeResponse, { sync_response: true })));
      };
    });
    cleanup.push(() => target.client.close(), () => target.server.close());
    const values: unknown[] = [];
    const ended = new Promise<string | undefined>((resolve) => {
      const subscription = target.client.subscribe(
        {
          op: 'gnmi-subscribe',
          id: 's',
          mode: 'stream',
          subscriptions: [{ path: '/c', mode: 'sample', sampleIntervalMs: 1000 }],
        },
        'json_ietf',
        {
          notification: (notification) => values.push(notification.updates[0]!.value.value),
          sync: () => subscription.cancel(),
          end: (error) => resolve(error?.codeName),
        },
      );
    });
    expect(await ended).toBe('CANCELLED');
    expect(values).toEqual([1, 2]);
    const request = decodeMessage(SubscribeRequest, target.calls[0]!.requests[0]!);
    // STREAM is mode 0, proto3's default, so it is not on the wire at all.
    expect(request).toMatchObject({
      subscribe: { encoding: 4, subscription: [{ mode: 2, sample_interval: 1_000_000_000n }] },
    });
    expect((request.subscribe as ProtoMessage).mode).toBeUndefined();
  });

  it('reports a lost connection to everything still running', async () => {
    const target = await fakeTarget(() => undefined);
    cleanup.push(() => target.server.close());
    const closed = new Promise<string>((resolve) => target.client.onClose(resolve));
    const pending = target.client.capabilities();
    target.client.close();
    await expect(pending).rejects.toBeTruthy();
    expect(await closed).toMatch(/closed/);
  });
});
