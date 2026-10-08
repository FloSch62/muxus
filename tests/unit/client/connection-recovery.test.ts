import { describe, expect, it } from 'vitest';
import {
  AUTO_RECONNECT_DELAYS_MS,
  autoReconnectDelayMs,
  autoReconnectNotice,
  canDiagnoseConnection,
  CONNECTION_INTERRUPTION_GRACE_MS,
  connectionFailureReason,
  isDiagnoseKey,
  reattachCommand,
  reconnectPrompt,
  rendererReattachDelayMs,
  RENDERER_REATTACH_DELAYS_MS,
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

describe('renderer reattachment', () => {
  it('retries a stable backend terminal before opening a replacement shell', () => {
    expect(
      RENDERER_REATTACH_DELAYS_MS.map((_delay, attempts) =>
        rendererReattachDelayMs(attempts),
      ),
    ).toEqual(RENDERER_REATTACH_DELAYS_MS);
    expect(rendererReattachDelayMs(RENDERER_REATTACH_DELAYS_MS.length)).toBeUndefined();
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


describe('connection diagnostics key', () => {
  it('is offered for network sessions that failed or dropped', () => {
    expect(canDiagnoseConnection('ssh', 'failed')).toBe(true);
    expect(canDiagnoseConnection('telnet', 'disconnected')).toBe(true);
    expect(canDiagnoseConnection('ssh', 'completed')).toBe(false);
    expect(canDiagnoseConnection('local', 'failed')).toBe(false);
    expect(canDiagnoseConnection('serial', 'failed')).toBe(false);
  });

  it('answers to D in either case only', () => {
    expect(isDiagnoseKey('d')).toBe(true);
    expect(isDiagnoseKey('D')).toBe(true);
    expect(isDiagnoseKey('\x04')).toBe(false);
    expect(isDiagnoseKey('dd')).toBe(false);
  });

  it('names the key in the prompts that offer it', () => {
    expect(reconnectPrompt(false)).toBe('Press any key to reconnect');
    expect(reconnectPrompt(true)).toBe(
      'Press D to diagnose the connection, any other key to reconnect',
    );
    expect(autoReconnectNotice(2_000, 1, false)).toBe(
      `Reconnecting in 2s (attempt 1 of ${AUTO_RECONNECT_DELAYS_MS.length}) — any key reconnects now`,
    );
    expect(autoReconnectNotice(5_000, 2, true)).toBe(
      `Reconnecting in 5s (attempt 2 of ${AUTO_RECONNECT_DELAYS_MS.length}) — D diagnoses, any other key reconnects now`,
    );
  });
});
