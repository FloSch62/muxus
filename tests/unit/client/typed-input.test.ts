import { describe, expect, it } from 'vitest';
import { MAX_PACED_PASTE_LENGTH } from '@muxus/shared';
import { terminalClientMessageSchema } from '@muxus/shared/ws-protocol';
import { typedInput } from '../../../client/src/terminal/typed-input.js';

const paced = { lineDelayMs: 250, charDelayMs: 0 };

describe('typedInput', () => {
  it('writes text at once when the host does not pace pastes', () => {
    expect(typedInput('show version\r', { lineDelayMs: 0, charDelayMs: 0 })).toEqual({
      kind: 'direct',
      data: 'show version\r',
    });
  });

  it('types through the backend pacer, never bracketed', () => {
    const message = {
      op: 'paste',
      text: 'conf t\rinterface Gi0/1\rend\r',
      bracketed: false,
      lineDelayMs: 250,
      charDelayMs: 0,
    } as const;

    expect(typedInput(message.text, paced)).toEqual({ kind: 'paced', message });
    expect(terminalClientMessageSchema.parse(message)).toEqual(message);
  });

  it('paces a single line when the host sets a character delay', () => {
    expect(typedInput('show ip route\r', { lineDelayMs: 0, charDelayMs: 20 }).kind).toBe('paced');
  });

  it('queues behind a running paste even when only that paste was paced', () => {
    expect(typedInput('uptime\r', { lineDelayMs: 0, charDelayMs: 0 }, true)).toEqual({
      kind: 'paced',
      message: { op: 'paste', text: 'uptime\r', bracketed: false, lineDelayMs: 0, charDelayMs: 0 },
    });
  });

  it("types line breaks as the host's Enter key, written at once or paced", () => {
    const unpaced = { lineDelayMs: 0, charDelayMs: 0 };
    expect(typedInput('conf t\rend\r', unpaced, false, 'crlf')).toEqual({
      kind: 'direct',
      data: 'conf t\r\nend\r\n',
    });
    expect(typedInput('conf t\rend\r', unpaced, false, 'lf')).toEqual({
      kind: 'direct',
      data: 'conf t\nend\n',
    });

    const message = {
      op: 'paste',
      text: 'conf t\rend\r',
      bracketed: false,
      lineDelayMs: 250,
      charDelayMs: 0,
      enterKey: 'lf',
    } as const;
    expect(typedInput(message.text, paced, false, 'lf')).toEqual({ kind: 'paced', message });
    expect(terminalClientMessageSchema.parse(message)).toEqual(message);
  });

  it('sends what it sent before for the default CR Enter key', () => {
    expect(typedInput('show version\r', { lineDelayMs: 0, charDelayMs: 0 }, false, 'cr')).toEqual(
      typedInput('show version\r', { lineDelayMs: 0, charDelayMs: 0 }),
    );
    expect(typedInput('uptime\r', paced, false, 'cr')).toEqual({
      kind: 'paced',
      message: { op: 'paste', text: 'uptime\r', bracketed: false, lineDelayMs: 250, charDelayMs: 0 },
    });
  });

  it('keeps escape characters intact', () => {
    expect(typedInput('\x1bq', paced)).toMatchObject({ message: { text: '\x1bq' } });
  });

  it('falls back to a direct write for empty or oversized text', () => {
    const long = 'x'.repeat(MAX_PACED_PASTE_LENGTH + 1);

    expect(typedInput('', paced)).toEqual({ kind: 'direct', data: '' });
    expect(typedInput(long, paced)).toEqual({ kind: 'direct', data: long });
  });
});
