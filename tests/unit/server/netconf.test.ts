import { Duplex, PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  encodeChunked,
  encodeEndOfMessage,
  NetconfDecoder,
  NetconfFramingError,
} from '../../../server/src/management/netconf/framing.js';
import { NetconfClient } from '../../../server/src/management/netconf/client.js';
import { decodeXmlEntities, parseHello, rootElement } from '../../../server/src/management/netconf/xml.js';

function feed(decoder: NetconfDecoder, data: Buffer, step: number): string[] {
  const messages: string[] = [];
  for (let offset = 0; offset < data.length; offset += step) messages.push(...decoder.push(data.subarray(offset, offset + step)));
  return messages;
}

describe('NETCONF framing', () => {
  it('splits end-of-message framing even when the marker straddles packets', () => {
    const stream = Buffer.concat([encodeEndOfMessage('<hello/>'), encodeEndOfMessage('<rpc-reply/>')]);
    for (const step of [1, 2, 3, 5, 7, 100]) {
      expect(feed(new NetconfDecoder(), stream, step)).toEqual(['<hello/>', '<rpc-reply/>']);
    }
  });

  it('reassembles chunked messages made of several chunks', () => {
    const multi = Buffer.from('\n#5\n<rpc-\n#9\nreply/>xy\n##\n');
    const stream = Buffer.concat([multi, encodeChunked('<ok/>')]);
    for (const step of [1, 4, 64]) {
      const decoder = new NetconfDecoder();
      decoder.useChunked();
      expect(feed(decoder, stream, step)).toEqual(['<rpc-reply/>xy', '<ok/>']);
    }
  });

  it('keeps bytes after the hello for the negotiated framing', () => {
    const decoder = new NetconfDecoder();
    const first = decoder.push(Buffer.concat([encodeEndOfMessage('<hello/>'), Buffer.from('\n#4\n<a/>')]));
    expect(first).toEqual(['<hello/>']);
    decoder.useChunked();
    expect(decoder.push(Buffer.from('\n##\n'))).toEqual(['<a/>']);
  });

  it('tolerates whitespace between chunked messages and rejects garbage', () => {
    const decoder = new NetconfDecoder();
    decoder.useChunked();
    expect(decoder.push(Buffer.from(' \r\n\n#3\nabc\n##\n'))).toEqual(['abc']);
    const broken = new NetconfDecoder();
    broken.useChunked();
    expect(() => broken.push(Buffer.from('\n#x\nabc'))).toThrow(NetconfFramingError);
    expect(() => broken.push(Buffer.from('garbage!'))).toThrow(NetconfFramingError);
  });

  it('limits message size', () => {
    const decoder = new NetconfDecoder(16);
    expect(() => decoder.push(Buffer.alloc(32, 0x61))).toThrow(/too large/);
  });
});

describe('NETCONF XML helpers', () => {
  it('finds the document element past the prolog, with unprefixed attribute names', () => {
    expect(rootElement('<?xml version="1.0"?>\n<!-- c --><nc:rpc-reply nc:message-id="7" xmlns:nc="x">')).toEqual({
      name: 'rpc-reply',
      attributes: { 'message-id': '7', 'xmlns:nc': 'x' },
    });
  });

  it('reads capabilities and the session id from a hello', () => {
    const hello = parseHello(
      '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities>' +
        '<capability>urn:ietf:params:netconf:base:1.1</capability>' +
        '<capability>urn:x?module=a&amp;revision=2020-01-01</capability>' +
        '</capabilities><session-id>42</session-id></hello>',
    );
    expect(hello).toEqual({
      capabilities: ['urn:ietf:params:netconf:base:1.1', 'urn:x?module=a&revision=2020-01-01'],
      sessionId: '42',
    });
    expect(() => parseHello('<rpc-reply/>')).toThrow(/hello/);
    expect(decodeXmlEntities('&lt;a&gt; &#65;&#x42;')).toBe('<a> AB');
  });
});

/** A NETCONF server on the far end of an in-memory channel. */
function fakeServer(options: { base11: boolean; reply(body: string, messageId: string): string | undefined }) {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const channel = Duplex.from({ readable: toClient, writable: fromClient });
  const decoder = new NetconfDecoder();
  const sent: string[] = [];
  let helloSeen = false;
  const send = (xml: string) => toClient.write(options.base11 && helloSeen ? encodeChunked(xml) : encodeEndOfMessage(xml));
  fromClient.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      sent.push(message);
      if (!helloSeen) {
        helloSeen = true;
        if (options.base11 && message.includes('base:1.1')) decoder.useChunked();
        continue;
      }
      const id = /message-id="([^"]+)"/.exec(message)?.[1] ?? '';
      const body = /<rpc[^>]*>([\s\S]*)<\/rpc>/.exec(message)?.[1] ?? '';
      const reply = options.reply(body, id);
      if (reply !== undefined) send(reply);
    }
  });
  const capabilities = ['urn:ietf:params:netconf:base:1.0', ...(options.base11 ? ['urn:ietf:params:netconf:base:1.1'] : [])];
  toClient.write(
    encodeEndOfMessage(
      `<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities>${capabilities
        .map((capability) => `<capability>${capability}</capability>`)
        .join('')}</capabilities><session-id>9</session-id></hello>`,
    ),
  );
  return { channel, sent, send };
}

describe('NETCONF client', () => {
  it('negotiates chunked framing and matches replies to their RPCs out of order', async () => {
    const held: Array<() => void> = [];
    const server = fakeServer({
      base11: true,
      reply: (body, id) => {
        const reply = `<rpc-reply message-id="${id}" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><data>${body}</data></rpc-reply>`;
        if (body.includes('slow')) {
          held.push(() => server.send(reply));
          return undefined;
        }
        return reply;
      },
    });
    const client = await NetconfClient.open(server.channel);
    expect(client.base).toBe('1.1');
    expect(client.sessionId).toBe('9');
    const slow = client.rpc('<slow/>');
    const fast = await client.rpc('<fast/>');
    expect(fast.xml).toContain('<fast/>');
    held.forEach((release) => release());
    expect((await slow).xml).toContain('<slow/>');
    expect(server.sent[0]).toContain('urn:ietf:params:netconf:base:1.1');
  });

  it('stays on end-of-message framing with a base:1.0 server and delivers notifications', async () => {
    const server = fakeServer({ base11: false, reply: (_body, id) => `<rpc-reply message-id="${id}"><ok/></rpc-reply>` });
    const client = await NetconfClient.open(server.channel);
    expect(client.base).toBe('1.0');
    const notifications: string[] = [];
    client.onNotification((notification) => notifications.push(notification.eventTime ?? ''));
    server.send(
      '<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"><eventTime>2026-10-10T10:00:00Z</eventTime><x/></notification>',
    );
    expect((await client.rpc('<get/>')).xml).toContain('<ok/>');
    expect(notifications).toEqual(['2026-10-10T10:00:00Z']);
  });

  it('fails pending RPCs when the channel closes and honours cancellation', async () => {
    const server = fakeServer({ base11: true, reply: () => undefined });
    const client = await NetconfClient.open(server.channel);
    const abort = new AbortController();
    const cancelled = client.rpc('<a/>', { signal: abort.signal });
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ cancelled: true });
    const pending = client.rpc('<b/>');
    const closed = new Promise<string>((resolve) => client.onClose(resolve));
    server.channel.destroy();
    await expect(pending).rejects.toThrow();
    expect(await closed).toBeTruthy();
    await expect(client.rpc('<c/>')).rejects.toThrow(/closed/);
  });

  it('rejects a server that does not start with a hello', async () => {
    const toClient = new PassThrough();
    const channel = Duplex.from({ readable: toClient, writable: new PassThrough() });
    toClient.write(encodeEndOfMessage('<rpc-reply/>'));
    await expect(NetconfClient.open(channel)).rejects.toThrow(/hello/);
  });
});
