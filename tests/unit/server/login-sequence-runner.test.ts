import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoginSequenceStep } from '@muxus/shared';
import {
  describeLoginStep,
  LoginSequenceRunner,
  type LoginSequenceIo,
  type LoginSequenceProgress,
} from '../../../server/src/login-sequence/runner.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');

function harness(
  steps: LoginSequenceStep[],
  options: { typeSecret?: LoginSequenceIo['typeSecret']; writable?: boolean } = {},
) {
  const written: string[] = [];
  const typed: string[] = [];
  const progress: LoginSequenceProgress[] = [];
  const io: LoginSequenceIo = {
    write: (data) => {
      if (options.writable === false) return false;
      written.push(data.toString('utf8'));
      return true;
    },
    typed: (data) => typed.push(data.toString('utf8')),
    typeSecret:
      options.typeSecret ??
      (async (_secretId, enter) => {
        written.push(`<secret>${enter ? '\r' : ''}`);
        return undefined;
      }),
    progress: (update) => progress.push(update),
  };
  const runner = new LoginSequenceRunner(steps, io, { secretName: () => 'Core enable' });
  return { runner, written, typed, progress };
}

const wait = (pattern: string, extra: Partial<Extract<LoginSequenceStep, { kind: 'wait' }>> = {}) =>
  ({ id: `w-${pattern}`, kind: 'wait', pattern, timeoutSeconds: 5, ...extra }) as const;
const send = (text: string, enter = true) => ({ id: `s-${text}`, kind: 'send', text, enter }) as const;
const secret = (enter = true) => ({ id: 'secret', kind: 'secret', secretId: 'sec-1', enter }) as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('LoginSequenceRunner', () => {
  it('waits for each prompt before answering it, in order', async () => {
    const { runner, written, typed, progress } = harness([
      wait('Press RETURN'),
      send(''),
      wait('Username:'),
      send('admin'),
      wait('assword:'),
      secret(),
    ]);
    const done = runner.run();
    await vi.waitFor(() => expect(progress.at(-1)?.detail).toBe('Waiting for “Press RETURN”'));
    expect(written).toEqual([]);

    runner.output(bytes('Welcome\r\nPress RE'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(written).toEqual([]);
    runner.output(bytes('TURN to get started'));
    await vi.waitFor(() => expect(written).toEqual(['\r']));

    runner.output(bytes('\r\nUsername: '));
    await vi.waitFor(() => expect(written).toEqual(['\r', 'admin\r']));
    runner.output(bytes('admin\r\nPassword: '));

    await expect(done).resolves.toEqual({ state: 'done' });
    expect(written).toEqual(['\r', 'admin\r', '<secret>\r']);
    // Plain sends count as typed input; the secret never reaches that path.
    expect(typed).toEqual(['\r', 'admin\r']);
    expect(progress.map(({ state, step, steps }) => `${state} ${step}/${steps}`)).toEqual([
      'running 1/6',
      'running 2/6',
      'running 3/6',
      'running 4/6',
      'running 5/6',
      'running 6/6',
      'done 6/6',
    ]);
  });

  it('counts output that arrived before the sequence started', async () => {
    const { runner, written } = harness([wait('login:'), send('root')]);
    runner.output(bytes('\x1b[1mlogin:\x1b[0m '));
    await expect(runner.run()).resolves.toEqual({ state: 'done' });
    expect(written).toEqual(['root\r']);
  });

  it('matches regular expressions', async () => {
    const { runner, written } = harness([wait('[>#]\\s*$', { regex: true }), send('enable')]);
    const done = runner.run();
    runner.output(bytes('router> '));
    await expect(done).resolves.toEqual({ state: 'done' });
    expect(written).toEqual(['enable\r']);
  });

  it('stops at a step that times out and says which one', async () => {
    vi.useFakeTimers();
    const { runner, written, progress } = harness([
      wait('login:'),
      send('admin'),
      wait('Password:', { timeoutSeconds: 3 }),
      send('never'),
    ]);
    const done = runner.run();
    runner.output(bytes('login: '));
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual(['admin\r']);
    runner.output(bytes('Passcode: '));
    await vi.advanceTimersByTimeAsync(2999);
    expect(progress.at(-1)?.state).toBe('running');
    await vi.advanceTimersByTimeAsync(1);

    const message = 'Step 3 timed out after 3 s waiting for “Password:”.';
    await expect(done).resolves.toEqual({ state: 'failed', step: 3, message });
    expect(progress.at(-1)).toMatchObject({ state: 'failed', step: 3, steps: 4, message });
    expect(written).toEqual(['admin\r']);
  });

  it('reports an invalid pattern instead of throwing', async () => {
    const { runner } = harness([wait('([', { regex: true })]);
    await expect(runner.run()).resolves.toMatchObject({
      state: 'failed',
      step: 1,
      message: expect.stringContaining('Step 1 has an invalid pattern'),
    });
  });

  it('can be cancelled while it waits', async () => {
    const { runner, written, progress } = harness([send('first'), wait('never'), send('late')]);
    const done = runner.run();
    await vi.waitFor(() => expect(progress.at(-1)?.step).toBe(2));
    runner.cancel();
    await expect(done).resolves.toEqual({ state: 'cancelled', step: 2 });
    expect(progress.at(-1)).toMatchObject({ state: 'cancelled', step: 2, steps: 3 });
    runner.output(bytes('never'));
    expect(written).toEqual(['first\r']);
  });

  it('cancels a vault step that is waiting for the master password', async () => {
    let signal: AbortSignal | undefined;
    const { runner, written } = harness([secret(), send('after')], {
      typeSecret: (_secretId, _enter, abort) => {
        signal = abort;
        return new Promise((resolve) => abort.addEventListener('abort', () => resolve(undefined)));
      },
    });
    const done = runner.run();
    await vi.waitFor(() => expect(signal).toBeDefined());
    runner.cancel();
    await expect(done).resolves.toEqual({ state: 'cancelled', step: 1 });
    expect(signal?.aborted).toBe(true);
    expect(written).toEqual([]);
  });

  it('stops when a vault secret cannot be typed', async () => {
    const { runner, written, progress } = harness([secret(), send('after')], {
      typeSecret: async () => 'its secret is no longer in the password vault.',
    });
    await expect(runner.run()).resolves.toEqual({
      state: 'failed',
      step: 1,
      message: 'Step 1: its secret is no longer in the password vault.',
    });
    expect(written).toEqual([]);
    expect(progress.at(-1)?.state).toBe('failed');
  });

  it('ends quietly when the session closes', async () => {
    const { runner, progress } = harness([wait('never')]);
    const done = runner.run();
    runner.close();
    await expect(done).resolves.toEqual({ state: 'closed' });
    expect(progress.map((update) => update.state)).toEqual(['running']);

    const gone = harness([send('x')], { writable: false });
    await expect(gone.runner.run()).resolves.toEqual({ state: 'closed' });
  });

  it('describes steps without showing secrets', () => {
    expect(describeLoginStep(wait('Password:'))).toBe('Waiting for “Password:”');
    expect(describeLoginStep(wait('[>#]$', { regex: true }))).toBe('Waiting for a match of “[>#]$”');
    expect(describeLoginStep(send('terminal length 0'))).toBe('Typing “terminal length 0” and Enter');
    expect(describeLoginStep(send('', true))).toBe('Pressing Enter');
    expect(describeLoginStep(secret(), 'Core enable')).toBe('Typing the secret “Core enable” and Enter');
    expect(describeLoginStep(send('x'.repeat(200), false))).toMatch(/^Typing “x{59}…”$/);
  });
});
