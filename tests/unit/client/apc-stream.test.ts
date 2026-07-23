import { describe, expect, it } from 'vitest';
import { KittyApcExtractor, parseGraphicsControl, type StreamPart } from '../../../client/src/terminal/apc-stream.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function collect(parts: StreamPart[]): { data: string; gfx: Array<{ control: string; payload: string }> } {
  let data = '';
  const gfx: Array<{ control: string; payload: string }> = [];
  for (const part of parts) {
    if (part.kind === 'data') data += dec.decode(part.data);
    else gfx.push(part.cmd);
  }
  return { data, gfx };
}

describe('KittyApcExtractor', () => {
  it('passes plain data through byte-identical', () => {
    const x = new KittyApcExtractor();
    const input = 'hello \x1b[31mred\x1b[0m world\r\n';
    const { data, gfx } = collect(x.feed(enc.encode(input)));
    expect(data).toBe(input);
    expect(gfx).toEqual([]);
  });

  it('extracts a kitty APC and removes it from the stream', () => {
    const x = new KittyApcExtractor();
    const input = 'before\x1b_Ga=T,f=100,i=7;QUJD\x1b\\after';
    const { data, gfx } = collect(x.feed(enc.encode(input)));
    expect(data).toBe('beforeafter');
    expect(gfx).toEqual([{ control: 'a=T,f=100,i=7', payload: 'QUJD' }]);
  });

  it('handles an APC with no payload', () => {
    const x = new KittyApcExtractor();
    const { data, gfx } = collect(x.feed(enc.encode('\x1b_Ga=d\x1b\\')));
    expect(data).toBe('');
    expect(gfx).toEqual([{ control: 'a=d', payload: '' }]);
  });

  it('reassembles an APC split across arbitrary chunk boundaries', () => {
    const input = enc.encode('AB\x1b_Ga=T,i=1;cGF5bG9hZA==\x1b\\CD');
    // Feed byte-by-byte — the cruellest chunking.
    const x = new KittyApcExtractor();
    const all: StreamPart[] = [];
    for (const byte of input) all.push(...x.feed(Uint8Array.of(byte)));
    const { data, gfx } = collect(all);
    expect(data).toBe('ABCD');
    expect(gfx).toEqual([{ control: 'a=T,i=1', payload: 'cGF5bG9hZA==' }]);
  });

  it('passes non-kitty APC strings through untouched', () => {
    const x = new KittyApcExtractor();
    const input = 'a\x1b_Xsomething\x1b\\b';
    const { data, gfx } = collect(x.feed(enc.encode(input)));
    expect(data).toBe(input);
    expect(gfx).toEqual([]);
  });

  it('does not treat kitty-looking content inside another APC as a command', () => {
    const x = new KittyApcExtractor();
    const input = '\x1b_XGa=T;zz\x1b\\tail';
    const { data, gfx } = collect(x.feed(enc.encode(input)));
    expect(data).toBe(input);
    expect(gfx).toEqual([]);
  });

  it('keeps lone escapes and double escapes intact', () => {
    const x = new KittyApcExtractor();
    const { data } = collect(x.feed(enc.encode('\x1b\x1b[A\x1bP+q\x1b\\')));
    expect(data).toBe('\x1b\x1b[A\x1bP+q\x1b\\');
  });

  it('handles consecutive graphics commands', () => {
    const x = new KittyApcExtractor();
    const { data, gfx } = collect(x.feed(enc.encode('\x1b_Gm=1;QQ==\x1b\\\x1b_Gm=0;Qg==\x1b\\')));
    expect(data).toBe('');
    expect(gfx).toEqual([
      { control: 'm=1', payload: 'QQ==' },
      { control: 'm=0', payload: 'Qg==' },
    ]);
  });
});

describe('parseGraphicsControl', () => {
  it('parses key=value pairs', () => {
    const ctl = parseGraphicsControl('a=T,f=100,s=640,v=480,i=42');
    expect(ctl.get('a')).toBe('T');
    expect(ctl.get('f')).toBe('100');
    expect(ctl.get('s')).toBe('640');
    expect(ctl.get('i')).toBe('42');
  });

  it('tolerates empty and malformed pairs', () => {
    const ctl = parseGraphicsControl('a=q,,x,=5,z=-3');
    expect(ctl.get('a')).toBe('q');
    expect(ctl.get('z')).toBe('-3');
    expect(ctl.has('x')).toBe(false);
  });
});
