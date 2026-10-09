import { describe, expect, it } from 'vitest';
import {
  LoginOutputBuffer,
  PatternTimeoutError,
  TerminalTextStream,
} from '../../../server/src/login-sequence/output-matcher.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('TerminalTextStream', () => {
  it('drops colours, cursor movement, titles and carriage returns', () => {
    const stream = new TerminalTextStream();
    expect(
      stream.write(
        bytes('\x1b]0;router: console\x07\x1b[1;33mWelcome\x1b[0m\r\n\x1b[2K\x1b(BPress \x1b[7mRETURN\x1b[m'),
      ),
    ).toBe('Welcome\nPress RETURN');
  });

  it('keeps escape sequences and characters that arrive split across chunks', () => {
    const stream = new TerminalTextStream();
    const euro = bytes('€');
    const parts = [
      bytes('Pass\x1b['),
      bytes('1;3'),
      bytes('2mword\x1b]2;ti'),
      bytes('tle\x1b'),
      bytes('\\: '),
      euro.subarray(0, 1),
      euro.subarray(1),
    ];
    expect(parts.map((part) => stream.write(part)).join('')).toBe('Password: €');
  });

  it('renders cursor-forward as the spaces it skips', () => {
    expect(new TerminalTextStream().write(bytes('Press\x1b[CRETURN to\x1b[3Cstart'))).toBe(
      'Press RETURN to   start',
    );
  });
});

describe('LoginOutputBuffer', () => {
  it('finds literal text split across chunks and through ANSI codes', () => {
    const buffer = new LoginOutputBuffer();
    buffer.append(bytes('banner\r\nPass'));
    expect(buffer.find('Password:')).toBeUndefined();
    buffer.append(bytes('\x1b[1mwo'));
    expect(buffer.find('Password:')).toBeUndefined();
    buffer.append(bytes('rd\x1b[0m: '));
    expect(buffer.find('Password:')).toEqual({ end: 'banner\nPassword:'.length });
  });

  it('matches regular expressions against the stripped text', () => {
    const buffer = new LoginOutputBuffer();
    buffer.append(bytes('\x1b[32mcore-sw1\x1b[0m>'));
    expect(buffer.find(/^\w+-sw\d+[>#]$/)).toEqual({ end: 'core-sw1>'.length });
    expect(buffer.find(/#$/)).toBeUndefined();
    // Literal text is matched exactly, never as a pattern.
    expect(buffer.find('sw\\d')).toBeUndefined();
  });

  it('consumes a match, so the next wait only sees later output', () => {
    const buffer = new LoginOutputBuffer();
    buffer.append(bytes('login: login: '));
    const first = buffer.find('login:')!;
    buffer.consume(first.end);
    expect(buffer.content).toBe(' login: ');
    buffer.consume(buffer.find('login:')!.end);
    expect(buffer.find('login:')).toBeUndefined();
  });

  it('keeps only a bounded window of the newest output', () => {
    const buffer = new LoginOutputBuffer(64);
    for (let index = 0; index < 100; index++) buffer.append(bytes(`noise line ${index}\r\n`));
    expect(buffer.content.length).toBeLessThanOrEqual(64);
    expect(buffer.find('noise line 0\n')).toBeUndefined();
    buffer.append(bytes('Username: '));
    expect(buffer.find('Username:')).toBeDefined();
    // A match that straddles the trimmed edge is still found after the trim.
    const edge = new LoginOutputBuffer(16);
    edge.append(bytes('0123456789Pass'));
    edge.append(bytes('word: '));
    expect(edge.find('Password:')).toBeDefined();
  });

  it('abandons a catastrophically backtracking pattern instead of stalling', () => {
    const buffer = new LoginOutputBuffer(8192, 50);
    buffer.append(bytes(`${'a'.repeat(40)}!`));
    const started = Date.now();
    expect(() => buffer.find(/^(a+)+$/)).toThrow(PatternTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
    // The buffer is still usable afterwards.
    expect(buffer.find(/a!$/)).toEqual({ end: 41 });
  });
});
