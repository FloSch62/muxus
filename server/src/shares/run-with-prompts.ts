import pty from 'node-pty';
import type { ShareCommand } from './share-commands.js';

export interface PromptRunResult {
  exitCode: number;
  /** Everything the command printed, answers excluded. */
  output: string;
  /** A prompt there was no answer for. */
  unanswered?: 'password' | 'user' | 'domain';
  /** A prompt came back after being answered: the answer was refused. */
  refused?: 'password' | 'user' | 'domain';
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run a mount command on a pseudo-terminal and type the answers to its
 * prompts. Mount tools read passwords from their terminal, so the password
 * never appears on a command line or in the process list. A prompt asked a
 * second time means the answer was wrong; the command is stopped then
 * instead of being left waiting.
 */
export function runWithPrompts(
  step: ShareCommand,
  answers: Partial<Record<'password' | 'user' | 'domain', string>>,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<PromptRunResult> {
  return new Promise((resolve, reject) => {
    let output = '';
    let pending = '';
    const asked = new Map<number, number>();
    let settled = false;
    let unanswered: PromptRunResult['unanswered'];
    let refused: PromptRunResult['refused'];
    let killed = false;
    let child: pty.IPty;
    try {
      child = pty.spawn(step.command, step.args, {
        name: 'dumb',
        cols: 200,
        rows: 24,
        cwd: process.cwd(),
        env: { ...process.env, ...options.env, LANG: process.env.LANG ?? 'C', LC_ALL: 'C' },
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const finish = (result: PromptRunResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
      finish(new Error(`${step.command} did not finish within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} seconds.`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.onData((data) => {
      output += data;
      pending += data;
      // A prompt waits at the end of what was printed, without a newline.
      const tail = pending.split(/\r?\n/).at(-1) ?? '';
      const index = (step.answers ?? []).findIndex(({ prompt }) => prompt.test(tail));
      if (index < 0) return;
      const rule = step.answers![index]!;
      const value = answers[rule.answer];
      const times = (asked.get(index) ?? 0) + 1;
      asked.set(index, times);
      pending = '';
      if (value === undefined || times > 1) {
        // Nothing to say, or the last answer was refused: stop rather than hang.
        if (value === undefined) unanswered = rule.answer;
        else refused = rule.answer;
        killed = true;
        child.kill();
        return;
      }
      child.write(`${value}\r`);
    });
    child.onExit(({ exitCode, signal }) =>
      finish({
        // A command stopped here (or by a signal) failed, whatever code it reports.
        exitCode: exitCode !== 0 ? exitCode : killed || signal ? 1 : 0,
        output: mask(output.replace(/\r/g, '').trim(), answers),
        ...(unanswered ? { unanswered } : {}),
        ...(refused ? { refused } : {}),
      }),
    );
  });
}

/** A terminal that echoes would print the password; never pass it on in messages. */
function mask(output: string, answers: Partial<Record<string, string>>): string {
  const secret = answers.password;
  return secret ? output.split(secret).join('********') : output;
}
