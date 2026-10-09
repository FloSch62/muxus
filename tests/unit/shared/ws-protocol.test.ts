import { describe, expect, it } from 'vitest';
import {
  sessionProfileSchema,
  TERMINAL_WS_PROTOCOL,
  terminalClientMessageSchema,
  terminalWebSocketProtocols,
} from '@muxus/shared/ws-protocol';

describe('terminalWebSocketProtocols', () => {
  it('offers a fixed selected protocol and a separate auth protocol', () => {
    expect(terminalWebSocketProtocols('secret')).toEqual([TERMINAL_WS_PROTOCOL, 'muxus.auth.secret']);
  });
});

describe('sessionProfileSchema', () => {
  it('accepts a minimal local profile', () => {
    expect(sessionProfileSchema.safeParse({ kind: 'local' }).success).toBe(true);
  });

  it('accepts structured local shell arguments and startup commands', () => {
    expect(
      sessionProfileSchema.parse({
        kind: 'local',
        shell: 'wsl.exe',
        args: ['-d', 'Ubuntu'],
        cwd: 'C:\\work',
        startupCommand: 'cd project\nnpm run dev',
      }),
    ).toEqual({
      kind: 'local',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu'],
      cwd: 'C:\\work',
      startupCommand: 'cd project\nnpm run dev',
    });
  });

  it('bounds local shell launch data', () => {
    expect(
      sessionProfileSchema.safeParse({
        kind: 'local',
        args: Array.from({ length: 65 }, () => 'arg'),
      }).success,
    ).toBe(false);
    expect(
      sessionProfileSchema.safeParse({
        kind: 'local',
        startupCommand: 'x'.repeat(32_769),
      }).success,
    ).toBe(false);
  });

  it('accepts a full ssh profile', () => {
    const parsed = sessionProfileSchema.safeParse({
      kind: 'ssh',
      target: 'web',
      port: 2222,
      user: 'alice',
      useConfig: false,
      keepaliveIntervalSeconds: 30,
      identityFiles: ['~/.ssh/work_ed25519'],
      identitiesOnly: true,
      proxyJump: ['bastion', 'ops@relay:2200'],
    });
    expect(parsed.success).toBe(true);
  });

  it('bounds the Muxus SSH keepalive fallback', () => {
    expect(
      sessionProfileSchema.safeParse({
        kind: 'ssh',
        target: 'web',
        keepaliveIntervalSeconds: 30,
      }).success,
    ).toBe(true);
    expect(
      sessionProfileSchema.safeParse({
        kind: 'ssh',
        target: 'web',
        keepaliveIntervalSeconds: 0,
      }).success,
    ).toBe(false);
    expect(
      sessionProfileSchema.safeParse({
        kind: 'ssh',
        target: 'web',
        keepaliveIntervalSeconds: 3601,
      }).success,
    ).toBe(false);
  });

  it('accepts Telnet profiles and supplies the standard port', () => {
    expect(sessionProfileSchema.parse({ kind: 'telnet', host: 'router.local' })).toEqual({
      kind: 'telnet',
      host: 'router.local',
      port: 23,
    });
    expect(
      sessionProfileSchema.safeParse({ kind: 'telnet', host: 'router.local', port: 2323 })
        .success,
    ).toBe(true);
  });

  it('accepts serial profiles and supplies conventional 8-N-1 defaults', () => {
    expect(sessionProfileSchema.parse({ kind: 'serial', path: '/dev/ttyUSB0' })).toEqual({
      kind: 'serial',
      path: '/dev/ttyUSB0',
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
    expect(
      sessionProfileSchema.safeParse({
        kind: 'serial',
        path: 'COM3',
        baudRate: 9600,
        dataBits: 7,
        stopBits: 2,
        parity: 'even',
        flowControl: 'hardware',
      }).success,
    ).toBe(true);
  });

  it('drops retired TERM overrides from legacy profiles', () => {
    expect(sessionProfileSchema.parse({ kind: 'ssh', target: 'web', term: 'xterm-kitty' })).toEqual({
      kind: 'ssh',
      target: 'web',
    });
  });

  it('rejects ssh profiles without a target', () => {
    expect(sessionProfileSchema.safeParse({ kind: 'ssh', target: '' }).success).toBe(false);
    expect(sessionProfileSchema.safeParse({ kind: 'ssh' }).success).toBe(false);
  });

  it('rejects out-of-range ports', () => {
    expect(sessionProfileSchema.safeParse({ kind: 'ssh', target: 'x', port: 0 }).success).toBe(false);
    expect(sessionProfileSchema.safeParse({ kind: 'ssh', target: 'x', port: 65536 }).success).toBe(false);
    expect(sessionProfileSchema.safeParse({ kind: 'telnet', host: 'x', port: 0 }).success).toBe(false);
  });

  it('keeps a serial break duration within 1 ms and 10 s', () => {
    expect(
      sessionProfileSchema.parse({ kind: 'serial', path: 'COM3', breakDurationMs: 500 }),
    ).toMatchObject({ breakDurationMs: 500 });
    for (const breakDurationMs of [0, 10_001, 2.5]) {
      expect(
        sessionProfileSchema.safeParse({ kind: 'serial', path: 'COM3', breakDurationMs }).success,
      ).toBe(false);
    }
  });

  it('rejects invalid serial framing and baud rates', () => {
    expect(
      sessionProfileSchema.safeParse({ kind: 'serial', path: 'COM3', baudRate: 0 }).success,
    ).toBe(false);
    expect(
      sessionProfileSchema.safeParse({ kind: 'serial', path: 'COM3', dataBits: 9 }).success,
    ).toBe(false);
    expect(
      sessionProfileSchema.safeParse({ kind: 'serial', path: '', parity: 'none' }).success,
    ).toBe(false);
  });

  it('bounds tunnel-owned SSH configuration', () => {
    expect(
      sessionProfileSchema.safeParse({
        kind: 'ssh',
        target: 'x',
        proxyJump: Array.from({ length: 9 }, (_, index) => `jump-${index}`),
      }).success,
    ).toBe(false);
    expect(
      sessionProfileSchema.safeParse({
        kind: 'ssh',
        target: 'x',
        identityFiles: [''],
      }).success,
    ).toBe(false);
  });
});

describe('ssh link host key fingerprints', () => {
  const fingerprint = 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8';

  it('accepts canonical fingerprints only', () => {
    for (const hostKeyFingerprint of [
      fingerprint,
      'MD5:c1:b1:30:29:d7:b8:de:6c:97:77:10:d7:46:41:63:87',
      'ssh-rsa MD5:c1:b1:30:29:d7:b8:de:6c:97:77:10:d7:46:41:63:87',
    ]) {
      expect(
        sessionProfileSchema.safeParse({ kind: 'ssh', target: 'x', hostKeyFingerprint }).success,
      ).toBe(true);
    }
    for (const hostKeyFingerprint of [
      '',
      `${fingerprint}=`,
      fingerprint.toLowerCase(),
      'SHA256:nope',
      'ssh-rsa-c1-b1-30-29-d7-b8-de-6c-97-77-10-d7-46-41-63-87',
    ]) {
      expect(
        sessionProfileSchema.safeParse({ kind: 'ssh', target: 'x', hostKeyFingerprint }).success,
      ).toBe(false);
    }
  });
});

describe('terminalClientMessageSchema', () => {
  it('accepts connect with profile and dimensions', () => {
    const parsed = terminalClientMessageSchema.safeParse({
      op: 'connect',
      profile: { kind: 'ssh', target: 'example.com' },
      freshTransport: 'fresh-1a2b',
      title: 'Production',
      cols: 80,
      rows: 24,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts attaching another renderer to a live terminal', () => {
    expect(
      terminalClientMessageSchema.safeParse({
        op: 'attach',
        terminalId: 'terminal-live',
        cols: 120,
        rows: 40,
      }).success,
    ).toBe(true);
  });

  it('accepts a BREAK request without parameters', () => {
    expect(terminalClientMessageSchema.parse({ op: 'send-break' })).toEqual({ op: 'send-break' });
  });

  it('accepts preparing and cancelling a live terminal handoff', () => {
    expect(terminalClientMessageSchema.safeParse({ op: 'prepare-transfer' }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ op: 'cancel-transfer' }).success).toBe(true);
  });

  it('rejects connect with non-positive dimensions', () => {
    expect(
      terminalClientMessageSchema.safeParse({ op: 'connect', profile: { kind: 'local' }, cols: 0, rows: 24 }).success,
    ).toBe(false);
  });

  it('accepts resize / auth-response / host-key-response', () => {
    expect(terminalClientMessageSchema.safeParse({ op: 'resize', cols: 120, rows: 40 }).success).toBe(true);
    expect(
      terminalClientMessageSchema.safeParse({
        op: 'auth-response',
        answers: ['hunter2'],
        rememberPassword: true,
      }).success,
    ).toBe(true);
    expect(
      terminalClientMessageSchema.safeParse({
        op: 'auth-response',
        answers: [],
        skipped: true,
      }).success,
    ).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ op: 'host-key-response', accept: true }).success).toBe(true);
  });

  it('bounds authentication answers', () => {
    expect(
      terminalClientMessageSchema.safeParse({
        op: 'auth-response',
        answers: ['x'.repeat(8193)],
      }).success,
    ).toBe(false);
  });

  it('requires an actual lifecycle, pause, or privacy change for logging controls', () => {
    expect(
      terminalClientMessageSchema.safeParse({ op: 'set-logging', enabled: true }).success,
    ).toBe(true);
    expect(
      terminalClientMessageSchema.safeParse({ op: 'set-logging', paused: true }).success,
    ).toBe(true);
    expect(
      terminalClientMessageSchema.safeParse({
        op: 'set-logging',
        captureInput: false,
      }).success,
    ).toBe(true);
    expect(
      terminalClientMessageSchema.safeParse({ op: 'set-logging' }).success,
    ).toBe(false);
  });

  it('starts a log file with or without a chosen path, never with a path alone', () => {
    expect(
      terminalClientMessageSchema.safeParse({ op: 'set-logging', logToFile: true }).success,
    ).toBe(true);
    expect(
      terminalClientMessageSchema.safeParse({
        op: 'set-logging',
        logToFile: true,
        logFilePath: '/home/user/router.log',
      }).success,
    ).toBe(true);
    expect(
      terminalClientMessageSchema.safeParse({
        op: 'set-logging',
        logFilePath: '/home/user/router.log',
      }).success,
    ).toBe(false);
    expect(
      terminalClientMessageSchema.safeParse({
        op: 'set-logging',
        logToFile: true,
        logFilePath: '   ',
      }).success,
    ).toBe(false);
  });

  it('accepts tab renames with a non-blank title', () => {
    expect(terminalClientMessageSchema.safeParse({ op: 'set-title', title: 'Pre-change' }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ op: 'set-title', title: '   ' }).success).toBe(false);
    expect(terminalClientMessageSchema.safeParse({ op: 'set-title', title: 'x'.repeat(501) }).success).toBe(false);
  });

  it('accepts a shell-less dial for ssh targets only', () => {
    expect(terminalClientMessageSchema.safeParse({ op: 'dial', profile: { kind: 'ssh', target: 'web' } }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ op: 'dial', profile: { kind: 'local' } }).success).toBe(false);
  });

  it('rejects unknown ops', () => {
    expect(terminalClientMessageSchema.safeParse({ op: 'exec', cmd: 'rm -rf /' }).success).toBe(false);
  });
});
