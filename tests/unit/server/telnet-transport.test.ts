import net, { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  TelnetCodec,
  TelnetTransport,
} from '../../../server/src/telnet/telnet-transport.js';

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const BINARY = 0;
const ECHO = 1;
const TTYPE = 24;
const NAWS = 31;

function codec(cols = 80, rows = 24) {
  const sent: Buffer[] = [];
  const received: Buffer[] = [];
  return {
    sent,
    received,
    codec: new TelnetCodec(
      cols,
      rows,
      (data) => sent.push(data),
      (data) => received.push(data),
    ),
  };
}

describe('TelnetCodec', () => {
  it('parses fragmented negotiation without leaking IAC bytes to the terminal', () => {
    const test = codec();
    test.codec.feed(
      Buffer.from([...Buffer.from('hello'), IAC, WILL]),
    );
    test.codec.feed(Buffer.from([ECHO, ...' world'.split('').map((char) => char.charCodeAt(0))]));

    expect(Buffer.concat(test.received).toString()).toBe('hello world');
    expect(test.sent).toEqual([Buffer.from([IAC, DO, ECHO])]);
  });

  it('answers terminal-type SEND sub-negotiation across chunk boundaries', () => {
    const test = codec();
    test.codec.feed(Buffer.from([IAC, DO, TTYPE]));
    test.codec.feed(Buffer.from([IAC, SB, TTYPE]));
    test.codec.feed(Buffer.from([1, IAC]));
    test.codec.feed(Buffer.from([SE]));

    expect(test.sent[0]).toEqual(Buffer.from([IAC, WILL, TTYPE]));
    expect(test.sent[1]).toEqual(
      Buffer.from([IAC, SB, TTYPE, 0, ...Buffer.from('xterm-256color'), IAC, SE]),
    );
  });

  it('advertises and updates the network window size', () => {
    const test = codec(132, 43);
    test.codec.feed(Buffer.from([IAC, DO, NAWS]));
    expect(test.sent).toEqual([
      Buffer.from([IAC, WILL, NAWS]),
      Buffer.from([IAC, SB, NAWS, 0, 132, 0, 43, IAC, SE]),
    ]);

    test.codec.resize(200, 50);
    expect(test.sent[2]).toEqual(Buffer.from([IAC, SB, NAWS, 0, 200, 0, 50, IAC, SE]));
  });

  it('refuses unsupported local and remote options', () => {
    const test = codec();
    test.codec.feed(Buffer.from([IAC, DO, 39, IAC, WILL, 34]));
    expect(test.sent).toEqual([
      Buffer.from([IAC, WONT, 39]),
      Buffer.from([IAC, DONT, 34]),
    ]);
  });

  it('escapes IAC and translates terminal newlines until binary mode is active', () => {
    const test = codec();
    expect(test.codec.encode(Buffer.from([65, 13, 255]))).toEqual(
      Buffer.from([65, 13, 10, 255, 255]),
    );

    test.codec.feed(Buffer.from([IAC, DO, BINARY]));
    expect(test.codec.encode(Buffer.from([13, 255]))).toEqual(Buffer.from([13, 255, 255]));
  });

  it('decodes NVT CR-NUL while preserving CR-LF', () => {
    const test = codec();
    test.codec.feed(Buffer.from([65, 13]));
    test.codec.feed(Buffer.from([0, 66, 13, 10, 67]));
    expect(Buffer.concat(test.received)).toEqual(Buffer.from([65, 13, 66, 13, 10, 67]));
  });
});

describe('TelnetTransport', () => {
  it('preserves an immediate server banner and carries terminal input over TCP', async () => {
    const fromClient: Buffer[] = [];
    let resolveInput: (() => void) | undefined;
    const inputReceived = new Promise<void>((resolve) => {
      resolveInput = resolve;
    });
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        fromClient.push(data);
        if (Buffer.concat(fromClient).includes(Buffer.from('admin\r\n'))) resolveInput?.();
      });
      socket.write(Buffer.from([IAC, WILL, ECHO, ...Buffer.from('login:')]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;

    let transport: TelnetTransport | undefined;
    try {
      transport = await TelnetTransport.connect(
        { kind: 'telnet', host: '127.0.0.1', port: address.port },
        80,
        24,
      );
      const banner = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        transport!.onData((data) => {
          chunks.push(data);
          const combined = Buffer.concat(chunks);
          if (combined.includes(Buffer.from('login:'))) resolve(combined);
        });
      });
      expect(banner.toString()).toContain('login:');

      transport.write(Buffer.from('admin\r'));
      await inputReceived;
      const wire = Buffer.concat(fromClient);
      expect(wire.includes(Buffer.from([IAC, DO, ECHO]))).toBe(true);
      expect(wire.includes(Buffer.from('admin\r\n'))).toBe(true);
    } finally {
      transport?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
