import { afterEach, describe, expect, it } from 'vitest';
import { setWindowPromptHost, windowDialHandlers, type WindowPrompt } from '../../../client/src/dial-prompts.js';

const request = { name: 'Sign in', instructions: '', prompts: [{ prompt: 'Password:', echo: false }] };

describe('window dial prompts', () => {
  afterEach(() => setWindowPromptHost(undefined));

  function host() {
    const shown: WindowPrompt[] = [];
    setWindowPromptHost((prompt) => {
      shown.push(prompt);
      return () => shown.splice(shown.indexOf(prompt), 1);
    });
    return shown;
  }

  it('queues a prompt and passes the answer back', async () => {
    const shown = host();
    const answer = windowDialHandlers().onAuthPrompt(request as never);
    expect(shown).toHaveLength(1);
    (shown[0] as Extract<WindowPrompt, { kind: 'auth' }>).resolve({ answers: ['x'] } as never);
    await expect(answer).resolves.toEqual({ answers: ['x'] });
  });

  it('takes back waiting prompts and answers them as cancelled when the dial gives up', async () => {
    const shown = host();
    const abort = new AbortController();
    const handlers = windowDialHandlers(abort.signal);
    const auth = handlers.onAuthPrompt(request as never);
    const hostKey = handlers.onHostKey({ host: 'h', port: 22 } as never);
    expect(shown).toHaveLength(2);

    abort.abort();

    await expect(auth).resolves.toBeNull();
    await expect(hostKey).resolves.toBe(false);
    expect(shown).toHaveLength(0);
    // A prompt asked after the abort is never shown.
    await expect(handlers.onAuthPrompt(request as never)).resolves.toBeNull();
    expect(shown).toHaveLength(0);
  });
});
