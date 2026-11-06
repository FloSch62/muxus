import { StringDecoder } from 'node:string_decoder';
import { nanoid } from 'nanoid';
import type { ClientChannel } from 'ssh2';
import { shellQuote, type ScriptRunState, type ScriptRunStatus } from '@muxus/shared';
import type { ConnectionLease } from '../ssh/connection-manager.js';
import { HttpProblem } from '../util/errors.js';

/** Output kept per run; older output is dropped from the start. */
const MAX_OUTPUT = 1024 * 1024;
/** Finished runs stay readable this long, so a slow poll still sees the end. */
const KEEP_FINISHED_MS = 30 * 60_000;
const MAX_RUNS = 1000;

/**
 * Runs the script from stdin as a temporary file, so it may be any size and
 * may itself read stdin (which is then empty). A `#!` line picks the
 * interpreter, as running the file would; otherwise POSIX sh. The file is
 * removed when the run ends. Exit 125 means the script never started.
 */
export const SCRIPT_WRAPPER = [
  'muxus_f=$(mktemp 2>/dev/null) || muxus_f="${TMPDIR:-/tmp}/muxus-script-$$"',
  "trap 'rm -f \"$muxus_f\"' EXIT",
  'cat > "$muxus_f" || exit 125',
  'IFS= read -r muxus_first < "$muxus_f" || muxus_first=',
  'case "$muxus_first" in',
  "  '#!'*) muxus_interp=${muxus_first#??}; $muxus_interp \"$muxus_f\" </dev/null ;;",
  '  *) sh "$muxus_f" </dev/null ;;',
  'esac',
].join('\n');

export function scriptCommand(): string {
  return `sh -c ${shellQuote(SCRIPT_WRAPPER)}`;
}

interface Run {
  id: string;
  state: ScriptRunState;
  exitCode?: number;
  error?: string;
  /** Output kept, starting at `base` characters into the whole output. */
  output: string;
  base: number;
  stop(state: ScriptRunState, error?: string): void;
  finishedAt?: number;
}

export interface ScriptRunsOptions {
  acquire(connId: string): ConnectionLease | undefined;
}

/** Scripts running on live SSH connections, read back by polling. */
export class ScriptRuns {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly options: ScriptRunsOptions) {}

  async start(connId: string, body: string, timeoutSeconds = 0): Promise<{ id: string }> {
    this.prune();
    const lease = this.options.acquire(connId);
    if (!lease) throw new HttpProblem(404, 'The SSH connection is gone. Run the script again.');
    let channel: ClientChannel;
    try {
      channel = await new Promise<ClientChannel>((resolve, reject) => {
        lease.connection.client.exec(scriptCommand(), (err, stream) => (err ? reject(err) : resolve(stream)));
      });
    } catch (err) {
      lease.release();
      throw new HttpProblem(502, `The host would not start the script: ${err instanceof Error ? err.message : String(err)}`);
    }

    const run: Run = { id: nanoid(10), state: 'running', output: '', base: 0, stop: () => undefined };
    this.runs.set(run.id, run);
    const append = (text: string) => {
      if (!text) return;
      run.output += text;
      if (run.output.length > MAX_OUTPUT) {
        const drop = run.output.length - MAX_OUTPUT;
        run.output = run.output.slice(drop);
        run.base += drop;
      }
    };
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    channel.on('data', (data: Buffer) => append(stdout.write(data)));
    channel.stderr.on('data', (data: Buffer) => append(stderr.write(data)));

    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (state: ScriptRunState, extra: { exitCode?: number; error?: string } = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      append(stdout.end() + stderr.end());
      run.state = state;
      if (extra.exitCode !== undefined) run.exitCode = extra.exitCode;
      if (extra.error) run.error = extra.error;
      run.finishedAt = Date.now();
      lease.release();
    };
    run.stop = (state, error) => {
      if (settled) return;
      // Ask the remote side to stop; closing the channel ends it either way.
      try {
        channel.signal('TERM');
      } catch {
        /* not every server takes signals */
      }
      channel.close();
      finish(state, error ? { error } : {});
    };
    channel.on('exit', (code: number | null, signal?: string) => {
      if (typeof code === 'number') {
        finish(code === 0 ? 'completed' : 'failed', {
          exitCode: code,
          ...(code === 125 && !run.output ? { error: 'The host could not store the script in a temporary file.' } : {}),
        });
      } else {
        finish('failed', { error: `Stopped by signal ${signal ?? 'unknown'}.` });
      }
    });
    channel.on('close', () => finish('failed', { error: 'The connection closed before the script finished.' }));
    lease.connection.onClose((reason) =>
      finish('failed', { error: `The SSH connection was lost${reason ? `: ${reason}` : '.'}` }),
    );
    if (timeoutSeconds > 0) {
      timer = setTimeout(() => run.stop('timed-out', `Stopped after ${formatDuration(timeoutSeconds)}.`), timeoutSeconds * 1000);
    }

    channel.end(body.endsWith('\n') ? body : `${body}\n`);
    return { id: run.id };
  }

  status(id: string, since = 0): ScriptRunStatus {
    const run = this.runs.get(id);
    if (!run) throw new HttpProblem(404, 'This run is no longer known.');
    const end = run.base + run.output.length;
    const from = Math.max(0, Math.min(since, end) - run.base);
    return {
      id: run.id,
      state: run.state,
      ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
      output: run.output.slice(from),
      offset: end,
      truncated: since < run.base,
      ...(run.error ? { error: run.error } : {}),
    };
  }

  cancel(id: string): void {
    this.runs.get(id)?.stop('cancelled');
  }

  stopAll(): void {
    for (const run of this.runs.values()) run.stop('cancelled');
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (run.finishedAt && now - run.finishedAt > KEEP_FINISHED_MS) this.runs.delete(id);
    }
    if (this.runs.size < MAX_RUNS) return;
    const finished = [...this.runs.values()]
      .filter((run) => run.finishedAt)
      .sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const run of finished.slice(0, this.runs.size - MAX_RUNS + 1)) this.runs.delete(run.id);
  }
}

function formatDuration(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}
