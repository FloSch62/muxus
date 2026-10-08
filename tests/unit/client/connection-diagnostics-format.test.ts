import { describe, expect, it } from 'vitest';
import { formatConnectionDiagnostics } from '../../../client/src/terminal/connection-diagnostics.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string) => text.replace(ANSI, '');

describe('formatConnectionDiagnostics', () => {
  it('prints one marked row per check and the conclusion last', () => {
    const text = formatConnectionDiagnostics({
      checked: 'web.example.com:22',
      checks: [
        { label: 'DNS', status: 'ok', detail: 'web.example.com → 192.0.2.10 (3 ms)' },
        { label: 'Ping', status: 'warn', detail: '192.0.2.10 did not reply' },
        { label: 'TCP', status: 'info', detail: '[2001:db8::10]:22: no IPv6 route' },
        { label: 'TCP', status: 'fail', detail: '192.0.2.10:22 refused the connection' },
      ],
      conclusion: 'Nothing listens on port 22.',
    });
    expect(text.endsWith('\r\n')).toBe(true);
    expect(plain(text).split('\r\n')).toEqual([
      '➤ Connection diagnostics for web.example.com:22',
      '  ✔ DNS  : web.example.com → 192.0.2.10 (3 ms)',
      '  ! Ping : 192.0.2.10 did not reply',
      '  • TCP  : [2001:db8::10]:22: no IPv6 route',
      '  ✘        192.0.2.10:22 refused the connection',
      '  → Nothing listens on port 22.',
      '',
    ]);
  });

  it('keeps control sequences from the server out of the terminal', () => {
    const text = formatConnectionDiagnostics({
      checked: 'h:22',
      checks: [{ label: 'SSH', status: 'fail', detail: 'answered "\x1b]0;owned\x07x"' }],
      conclusion: 'line one\nline two',
    });
    // Only the formatter's own colours remain; no byte from the report can act.
    const visible = plain(text).replaceAll('\r\n', '');
    const controls = Array.from({ length: visible.length }, (_, i) => visible.charCodeAt(i)).filter(
      (code) => code < 0x20 || code === 0x7f,
    );
    expect(controls).toEqual([]);
    expect(plain(text)).toContain('  → line one line two');
  });
});
