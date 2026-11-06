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

/** Written to stderr before the script runs: the run's process group. */
const JOB_MARKER = new RegExp(`${String.fromCharCode(0x1e)}muxus-job (\\d+)\\n`);
/** Stderr held back while waiting for the marker, at most. */
const MAX_HELD_STDERR = 64 * 1024;

/**
 * Runs the script from stdin as a temporary file, so it may be any size and
 * may itself read stdin (which is then empty). A `#!` line picks the
 * interpreter, as running the file would; otherwise POSIX sh. The file is
 * removed when the run ends. Exit 125 means the script never started.
 *
 * sshd starts each exec session in a session of its own, so the run — this
 * wrapper, the script and whatever it starts — is one process group. The
 * wrapper reports that group on stderr before the script starts, so a
 * cancel can stop all of it; closing the channel alone would not. Without
 * mktemp, the fallback file is created exclusively and private.
 */
export const SCRIPT_WRAPPER = [
  // A TMPDIR that points nowhere should not stop the script: try /tmp too.
  'muxus_f=$(mktemp 2>/dev/null) || muxus_f=$(mktemp /tmp/muxus-script.XXXXXX 2>/dev/null) || {',
  '  muxus_f="/tmp/muxus-script-$$"',
  '  (umask 077; set -C; : > "$muxus_f") 2>/dev/null || exit 125',
  '}',
  "trap 'rm -f \"$muxus_f\"' EXIT",
  "trap 'exit 143' HUP INT TERM",
  'cat > "$muxus_f" || exit 125',
  "muxus_g=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')",
  "printf '\\036muxus-job %s\\n' \"${muxus_g:-$$}\" >&2",
  'IFS= read -r muxus_first < "$muxus_f" || muxus_first=',
  'case "$muxus_first" in',
  "  '#!'*) muxus_interp=${muxus_first#??}; $muxus_interp \"$muxus_f\" </dev/null ;;",
  '  *) sh "$muxus_f" </dev/null ;;',
  'esac',
].join('\n');

/** Stop a run's process group: TERM, then KILL if it is still there. */
export function killJobCommand(group: number): string {
  const kill = (signal: string) => `kill -${signal} -${group} 2>/dev/null || kill -${signal} ${group} 2>/dev/null`;
  return `${kill('TERM')}; (sleep 5; ${kill('KILL')}) </dev/null >/dev/null 2>&1 &`;
}

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
    // A host that refuses at once (cmd.exe has no sh) can send its exit status
    // with the exec reply, before the listeners below exist; keep it.
    let exit: { code: number | null; signal?: string } | undefined;
    try {
      channel = await new Promise<ClientChannel>((resolve, reject) => {
        lease.connection.client.exec(scriptCommand(), (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          stream.once('exit', (code: number | null, signal?: string) => {
            exit = { code, signal };
          });
          resolve(stream);
        });
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
    // Stderr is held until the job marker is seen and taken out of it.
    let job: number | undefined;
    let heldStderr = '';
    const takeStderr = (text: string) => {
      if (job !== undefined) return append(text);
      heldStderr += text;
      const marker = JOB_MARKER.exec(heldStderr);
      if (marker) {
        job = Number(marker[1]);
        append(heldStderr.slice(0, marker.index) + heldStderr.slice(marker.index + marker[0].length));
        heldStderr = '';
      } else if (heldStderr.length > MAX_HELD_STDERR) {
        append(heldStderr);
        heldStderr = '';
        job = -1;
      }
    };
    channel.on('data', (data: Buffer) => append(stdout.write(data)));
    channel.stderr.on('data', (data: Buffer) => takeStderr(stderr.write(data)));

    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let released = false;
    let unsubscribe = () => {};
    const release = () => {
      if (released) return;
      released = true;
      unsubscribe();
      lease.release();
    };
    const finish = (state: ScriptRunState, extra: { exitCode?: number; error?: string } = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      append(stdout.end());
      takeStderr(stderr.end());
      append(heldStderr);
      heldStderr = '';
      run.state = state;
      if (extra.exitCode !== undefined) run.exitCode = extra.exitCode;
      if (extra.error) run.error = extra.error;
      run.finishedAt = Date.now();
    };
    run.stop = (state, error) => {
      if (settled) return;
      finish(state, error ? { error } : {});
      // Closing the channel leaves a background script running; stop its
      // process group over the same connection, then let go of it.
      const stopped = job !== undefined && job > 1 ? this.killJob(lease, job) : Promise.resolve();
      void stopped.finally(() => {
        try {
          channel.signal('TERM');
        } catch {
          /* not every server takes signals */
        }
        channel.close();
        release();
      });
    };
    // Exit status can arrive before the last output; the run ends on close.
    channel.on('close', () => {
      if (!exit) {
        finish('failed', { error: 'The connection closed before the script finished.' });
      } else if (typeof exit.code === 'number') {
        finish(exit.code === 0 ? 'completed' : 'failed', {
          exitCode: exit.code,
          ...(exit.code === 125 && !run.output ? { error: 'The host could not store the script in a temporary file.' } : {}),
          // No marker: the wrapper itself never ran, e.g. on a Windows host
          // whose shell is cmd.exe, whatever language it answers in.
          ...(exit.code !== 0 && exit.code !== 125 && job === undefined
            ? { error: 'The script never started: this host has no POSIX shell (sh). Scripts run on Linux and Unix hosts.' }
            : {}),
        });
      } else {
        finish('failed', { error: `Stopped by signal ${exit.signal ?? 'unknown'}.` });
      }
      release();
    });
    unsubscribe = lease.connection.onClose((reason) => {
      finish('failed', { error: `The SSH connection was lost${reason ? `: ${reason}` : '.'}` });
      release();
    });
    if (timeoutSeconds > 0) {
      timer = setTimeout(() => run.stop('timed-out', `Stopped after ${formatDuration(timeoutSeconds)}.`), timeoutSeconds * 1000);
    }

    channel.end(body.endsWith('\n') ? body : `${body}\n`);
    return { id: run.id };
  }

  /** Run the kill command for a job's process group; settles when it is done or after a few seconds. */
  private killJob(lease: ConnectionLease, job: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      try {
        lease.connection.client.exec(killJobCommand(job), (err, stream) => {
          if (err) {
            clearTimeout(timer);
            resolve();
            return;
          }
          stream.on('close', () => {
            clearTimeout(timer);
            resolve();
          });
          stream.resume();
          stream.stderr.resume();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
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
