import { describe, expect, it } from 'vitest';
import { sessionProfileSchema, terminalClientMessageSchema } from '@muxus/shared/ws-protocol';

describe('sessionProfileSchema', () => {
  it('accepts a minimal local profile', () => {
    expect(sessionProfileSchema.safeParse({ kind: 'local' }).success).toBe(true);
  });

  it('accepts a full ssh profile', () => {
    const parsed = sessionProfileSchema.safeParse({
      kind: 'ssh',
      target: 'web',
      port: 2222,
      user: 'alice',
      term: 'xterm-kitty',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects ssh profiles without a target', () => {
    expect(sessionProfileSchema.safeParse({ kind: 'ssh', target: '' }).success).toBe(false);
    expect(sessionProfileSchema.safeParse({ kind: 'ssh' }).success).toBe(false);
  });

  it('rejects out-of-range ports', () => {
    expect(sessionProfileSchema.safeParse({ kind: 'ssh', target: 'x', port: 0 }).success).toBe(false);
    expect(sessionProfileSchema.safeParse({ kind: 'ssh', target: 'x', port: 65536 }).success).toBe(false);
  });
});

describe('terminalClientMessageSchema', () => {
  it('accepts connect with profile and dimensions', () => {
    const parsed = terminalClientMessageSchema.safeParse({
      op: 'connect',
      profile: { kind: 'ssh', target: 'example.com' },
      cols: 80,
      rows: 24,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects connect with non-positive dimensions', () => {
    expect(
      terminalClientMessageSchema.safeParse({ op: 'connect', profile: { kind: 'local' }, cols: 0, rows: 24 }).success,
    ).toBe(false);
  });

  it('accepts resize / auth-response / host-key-response', () => {
    expect(terminalClientMessageSchema.safeParse({ op: 'resize', cols: 120, rows: 40 }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ op: 'auth-response', answers: ['hunter2'] }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ op: 'host-key-response', accept: true }).success).toBe(true);
  });

  it('rejects unknown ops', () => {
    expect(terminalClientMessageSchema.safeParse({ op: 'exec', cmd: 'rm -rf /' }).success).toBe(false);
  });
});
