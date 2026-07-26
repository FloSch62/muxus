import { describe, expect, it } from 'vitest';
import {
  AUTO_RECONNECT_DELAYS_MS,
  autoReconnectDelayMs,
  CONNECTION_INTERRUPTION_GRACE_MS,
  connectionFailureReason,
  reattachCommand,
  shouldDelayConnectionLost,
  shouldWaitForTerminalOutput,
  terminalNotice,
  type AutoReconnectInput,
} from '../../../client/src/connection-recovery.js';

describe('connection failure presentation', () => {
  it('prefers the specific server reason', () => {
    expect(
      connectionFailureReason(
        {
          op: 'exit',
          reason: 'failed',
          message: 'jump host could not reach router.internal:22',
        },
        { code: 1011 },
      ),
    ).toBe('jump host could not reach router.internal:22');
  });

  it('explains normal, nonzero, and abnormal socket closes', () => {
    expect(
      connectionFailureReason({ op: 'exit', reason: 'completed', code: 0 }, { code: 1000 }),
    ).toBe('The shell exited normally.');
    expect(
      connectionFailureReason({ op: 'exit', reason: 'completed', code: 127 }, { code: 1000 }),
    ).toBe('The shell exited with status 127.');
    expect(connectionFailureReason(undefined, { code: 1006 })).toBe(
      'The connection to the Muxus backend was interrupted.',
    );
  });

  it('strips terminal control input from server error text', () => {
    expect(terminalNotice('bad\u001b[31m\r\nnews')).toBe('bad news');
  });

  it('uses a passive grace period only after a live session is interrupted', () => {
    expect(CONNECTION_INTERRUPTION_GRACE_MS).toBe(5_000);
    expect(
      shouldDelayConnectionLost(
        { op: 'exit', reason: 'disconnected', message: 'transport closed' },
        true,
      ),
    ).toBe(true);
    expect(shouldDelayConnectionLost(undefined, true)).toBe(true);
    expect(shouldDelayConnectionLost({ op: 'exit', reason: 'failed' }, false)).toBe(false);
    expect(shouldDelayConnectionLost({ op: 'exit', reason: 'completed' }, true)).toBe(false);
  });

  it('keeps SSH yellow until terminal output passively confirms responsiveness', () => {
    expect(shouldWaitForTerminalOutput('ssh', false)).toBe(true);
    expect(shouldWaitForTerminalOutput('ssh', true)).toBe(false);
    expect(shouldWaitForTerminalOutput('local', false)).toBe(false);
    expect(shouldWaitForTerminalOutput('telnet', false)).toBe(false);
    expect(shouldWaitForTerminalOutput('serial', false)).toBe(false);
  });
});

describe('automatic reconnection', () => {
  const drop = (overrides: Partial<AutoReconnectInput> = {}): AutoReconnectInput => ({
    enabled: true,
    profileKind: 'ssh',
    reason: 'disconnected',
    attempts: 0,
    sawAuthPrompt: false,
    ...overrides,
  });

  it('redials a dropped remote session with growing delays until the budget runs out', () => {
    expect(autoReconnectDelayMs(drop())).toBe(2_000);
    expect(autoReconnectDelayMs(drop({ attempts: 1 }))).toBe(5_000);
    expect(autoReconnectDelayMs(drop({ attempts: 2 }))).toBe(15_000);
    expect(autoReconnectDelayMs(drop({ attempts: AUTO_RECONNECT_DELAYS_MS.length }))).toBeUndefined();
  });

  it('never dials on its own when disabled, local, or exited normally', () => {
    expect(autoReconnectDelayMs(drop({ enabled: false }))).toBeUndefined();
    expect(autoReconnectDelayMs(drop({ profileKind: 'local' }))).toBeUndefined();
    expect(autoReconnectDelayMs(drop({ reason: 'completed' }))).toBeUndefined();
  });

  it('continues a chain through failed dials but never starts one from a failure', () => {
    expect(autoReconnectDelayMs(drop({ reason: 'failed' }))).toBeUndefined();
    expect(autoReconnectDelayMs(drop({ reason: 'failed', attempts: 1 }))).toBe(5_000);
    expect(
      autoReconnectDelayMs(drop({ reason: 'failed', attempts: 1, sawAuthPrompt: true })),
    ).toBeUndefined();
  });

  it('still redials after a drop when auth was interactive', () => {
    expect(autoReconnectDelayMs(drop({ sawAuthPrompt: true }))).toBe(2_000);
  });
});

describe('multiplexer reattachment', () => {
  it('attaches an existing tmux session or creates one', () => {
    const command = reattachCommand('tmux');
    expect(command).toContain('tmux attach-session');
    expect(command).toContain('tmux new-session');
    expect(command.endsWith('\r')).toBe(true);
  });

  it('uses screen reattachment mode', () => {
    expect(reattachCommand('screen')).toContain('screen -xRR');
  });
});
