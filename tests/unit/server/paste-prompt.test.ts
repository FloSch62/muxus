import { describe, expect, it } from 'vitest';
import { DEFAULT_PASTE_ERROR_PATTERN, DEFAULT_PASTE_PROMPT_PATTERN } from '@muxus/shared';
import { pastedLineText, PastePromptWatch } from '../../../server/src/ws/paste-prompt.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');
const defaults = { promptPattern: DEFAULT_PASTE_PROMPT_PATTERN, errorPattern: DEFAULT_PASTE_ERROR_PATTERN };

function watching(...chunks: string[]) {
  const watch = new PastePromptWatch(defaults);
  for (const chunk of chunks) watch.append(bytes(chunk));
  return watch;
}

describe('PastePromptWatch', () => {
  it('finds the prompt on the line the device starts after the echo', () => {
    const watch = new PastePromptWatch(defaults);
    watch.append(bytes('description uplink to core#'));
    // The echo of a line ending in # is not the prompt.
    expect(watch.check()).toBeUndefined();
    watch.append(bytes('\r\n'));
    expect(watch.check()).toBeUndefined();
    watch.append(bytes('R1(config-if)# '));
    expect(watch.check()).toEqual({ kind: 'prompt' });
    // Shell and Junos prompts too.
    expect(watching('ls\r\n', 'file\r\nuser@host:~$ ').check()).toEqual({ kind: 'prompt' });
    expect(watching('show\r\n', '{master}\r\nadmin@mx> ').check()).toEqual({ kind: 'prompt' });
  });

  it('reports the output line an error pattern matches, a line at a time', () => {
    const watch = watching(
      'interface bogus\r\n',
      "                ^\r\n% Invalid input detected at '^' marker.\r\n\r\nR1(config)#",
    );
    expect(watch.check()).toEqual({
      kind: 'error',
      line: "% Invalid input detected at '^' marker.",
    });
    // ^ is the start of a line, not of the output.
    expect(watching('x\r\nnot % Invalid\r\nR1#').check()).toEqual({ kind: 'prompt' });
    expect(watching('x\r\n% Incomplete command.\r\n').check()).toMatchObject({ kind: 'error' });
  });

  it('reads through escape sequences, carriage returns and chunk boundaries', () => {
    const watch = watching('show\r', '\n\x1b[31m% Ambig', 'uous comm\x1b[0', 'mand: "sh"\x1b[K\r', '\n');
    expect(watch.check()).toEqual({ kind: 'error', line: '% Ambiguous command: "sh"' });
    expect(watching('x\r\n\x1b]0;R1\x07R1\x1b[1', 'm#\x1b[0m').check()).toEqual({ kind: 'prompt' });
  });

  it('forgets what came before the line it answers', () => {
    const watch = watching('% Invalid input\r\nR1#');
    watch.reset();
    expect(watch.check()).toBeUndefined();
    watch.append(bytes('next\r\nR1#'));
    expect(watch.check()).toEqual({ kind: 'prompt' });
  });

  it('checks every line of a long answer once, and only so much of it', () => {
    const watch = new PastePromptWatch(defaults);
    watch.append(bytes(`${'interface Ethernet1\r\n'.repeat(1000)}% Invalid input\r\n`));
    expect(watch.check()).toEqual({ kind: 'error', line: '% Invalid input' });
    expect(watch.check()).toBeUndefined();
    // An error early in an answer that takes several regex runs.
    expect(
      watching(`x\r\n% Invalid input\r\n${'interface Ethernet1\r\n'.repeat(1000)}R1#`).check(),
    ).toEqual({ kind: 'error', line: '% Invalid input' });

    // Past the first 64 KiB of an answer, output is only searched for the prompt.
    const flood = new PastePromptWatch(defaults);
    flood.append(bytes(`${'x'.repeat(99)}\r\n`.repeat(700)));
    flood.append(bytes('% Invalid input\r\nR1#'));
    expect(flood.check()).toEqual({ kind: 'prompt' });
    // Also when the error comes in the same chunk as the first 64 KiB.
    expect(
      watching(`${'x'.repeat(99)}\r\n`.repeat(700) + '% Invalid input\r\nR1#').check(),
    ).toEqual({ kind: 'prompt' });
  });

  it('looks for the prompt only when asked to, and keeps checking errors', () => {
    const watch = new PastePromptWatch({ ...defaults, promptPattern: '^(a+)+$' }, 50);
    watch.append(bytes(`x\r\n${'a'.repeat(40)}!`));
    expect(watch.check(false)).toBeUndefined();
    expect(watch.check()).toEqual({
      kind: 'failed',
      message: 'the prompt pattern took too long to match',
    });
    expect(watching('x\r\nR1#').check(false)).toBeUndefined();
    expect(watching('x\r\n% Invalid input\r\nR1#').check(false)).toMatchObject({ kind: 'error' });
  });

  it('spends no more than the time limit on one check, over every regex run', () => {
    // Backtracks a while on every line. The limit is set from how long one regex run over a
    // window of such lines takes here: each run stays under it, eight of them do not.
    const errorPattern = '^(x+x+)+y';
    const window = `${'x'.repeat(15)}\r\n`.repeat(480);
    const probe = new PastePromptWatch({ ...defaults, errorPattern }, 10_000);
    probe.append(bytes(window));
    let started = performance.now();
    probe.check();
    const limit = Math.ceil((performance.now() - started) * 2.5);

    const watch = new PastePromptWatch({ ...defaults, errorPattern }, limit);
    watch.append(bytes(window.repeat(8)));
    started = performance.now();
    expect(watch.check()).toEqual({
      kind: 'failed',
      message: 'the error pattern took too long to match',
    });
    expect(performance.now() - started).toBeLessThan(limit * 2);
  });

  it('abandons a pattern that backtracks too long instead of stalling', () => {
    const watch = new PastePromptWatch({ ...defaults, errorPattern: '^(a+)+$' }, 50);
    watch.append(bytes(`${'a'.repeat(40)}!\r\n`));
    const started = Date.now();
    expect(watch.check()).toEqual({
      kind: 'failed',
      message: 'the error pattern took too long to match',
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a pattern that does not compile', () => {
    expect(() => new PastePromptWatch({ ...defaults, promptPattern: '([' })).toThrow(SyntaxError);
  });
});

describe('pastedLineText', () => {
  it('quotes a pasted line as the device shows it, trimmed and shortened', () => {
    expect(pastedLineText('  switchport mode acess\r')).toBe('switchport mode acess');
    expect(pastedLineText('\x1b[31mdescription\x1b[0m uplink\x07\r')).toBe('description uplink');
    expect(pastedLineText(`description ${'a'.repeat(300)}\r`)).toBe(`description ${'a'.repeat(187)}…`);
  });
});
