import { execFile, spawn } from 'node:child_process';
import type { Client, ClientChannel } from 'ssh2';
import { shellQuote } from '@muxus/shared';

/**
 * One command a discovery or lookup runs on a host. The program is looked up
 * on the host's PATH first, so a missing tool reads as "not installed" rather
 * than as a failure.
 */
export interface Probe {
  id: string;
  argv: string[];
}

export type ProbeResult =
  | { status: 'missing' }
  | { status: 'ran'; exitCode: number; stdout: string; stderr: string };

export type ProbeResults = Map<string, ProbeResult>;

/** Runs a batch of probes on one host and reports each by id. */
export type ProbeRunner = (probes: readonly Probe[]) => Promise<ProbeResults>;

/** One probe may wait on a slow cluster or daemon this long before it is stopped. */
export const PROBE_TIMEOUT_SECONDS = 12;
/** The whole batch, should the host have no `timeout` to stop one probe. */
const BATCH_TIMEOUT_MS = 60_000;
/** Pod lists and topology files can be large, but not this large. */
const MAX_OUTPUT = 16 * 1024 * 1024;

const SECTION = '@@muxus-env:';
const EXIT = '@@muxus-env-exit:';
const MISSING = '@@muxus-env-missing';

/**
 * One POSIX sh script for the whole batch, so a remote host is asked over a
 * single exec channel. stderr goes to a temporary file and follows the exit
 * marker, which keeps JSON on stdout clean of warnings. Nothing stays behind.
 */
export function probeScript(probes: readonly Probe[]): string {
  return [
    'LC_ALL=C',
    'export LC_ALL',
    'PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:/snap/bin"',
    'export PATH',
    'muxus_limit=""',
    `if command -v timeout >/dev/null 2>&1; then muxus_limit="timeout ${PROBE_TIMEOUT_SECONDS}"; fi`,
    'muxus_err=$(mktemp 2>/dev/null) || muxus_err="${TMPDIR:-/tmp}/muxus-env-$$"',
    'muxus_probe() {',
    `  printf '\\n${SECTION}%s\\n' "$1"`,
    '  shift',
    '  if command -v "$1" >/dev/null 2>&1; then',
    '    $muxus_limit "$@" </dev/null 2>"$muxus_err"',
    `    printf '\\n${EXIT}%s\\n' "$?"`,
    '    cat "$muxus_err" 2>/dev/null',
    '  else',
    `    printf '\\n${MISSING}\\n'`,
    '  fi',
    '}',
    ...probes.map((probe) => ['muxus_probe', shellQuote(probe.id), ...probe.argv.map(shellQuote)].join(' ')),
    'rm -f "$muxus_err"',
    '',
  ].join('\n');
}

/** Split a batch's output back into its probes. Text before the first marker (a banner) is ignored. */
export function parseProbeOutput(output: string): ProbeResults {
  const results: ProbeResults = new Map();
  const parts = output.split(`\n${SECTION}`);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    const id = (newline < 0 ? part : part.slice(0, newline)).trim();
    const body = newline < 0 ? '' : part.slice(newline + 1);
    if (!id) continue;
    if (body.trimStart().startsWith(MISSING)) {
      results.set(id, { status: 'missing' });
      continue;
    }
    const exitAt = body.lastIndexOf(`\n${EXIT}`);
    const exitStart = exitAt >= 0 ? exitAt : body.startsWith(EXIT) ? -1 : undefined;
    if (exitStart === undefined) {
      // Cut off mid-probe: the batch timed out or the channel closed.
      results.set(id, { status: 'ran', exitCode: 124, stdout: body, stderr: 'timed out' });
      continue;
    }
    const stdout = exitStart < 0 ? '' : body.slice(0, exitStart);
    const tail = body.slice(exitStart + 1 + EXIT.length);
    const tailNewline = tail.indexOf('\n');
    const exitCode = Number.parseInt(tailNewline < 0 ? tail : tail.slice(0, tailNewline), 10);
    const stderr = tailNewline < 0 ? '' : tail.slice(tailNewline + 1);
    results.set(id, {
      status: 'ran',
      exitCode: Number.isFinite(exitCode) ? exitCode : 1,
      stdout,
      stderr: stderr.trim(),
    });
  }
  return results;
}

function collect(stream: NodeJS.ReadableStream, stop: () => void): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => {
      stop();
      finish();
    }, BATCH_TIMEOUT_MS);
    timer.unref();
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (size + buffer.length > MAX_OUTPUT) return;
      size += buffer.length;
      chunks.push(buffer);
    });
    stream.once('close', finish);
    stream.once('end', finish);
    stream.once('error', finish);
  });
}

/** Probes over an exec channel on a live SSH transport; `sh -s` keeps the login shell's syntax out of it. */
export function remoteProbeRunner(client: Client): ProbeRunner {
  return async (probes) => {
    if (probes.length === 0) return new Map();
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec('sh -s', (error, stream) => (error ? reject(error) : resolve(stream)));
    });
    channel.stderr.resume();
    const output = collect(channel, () => channel.destroy());
    channel.end(probeScript(probes));
    return parseProbeOutput(await output);
  };
}

/** Probes on the computer running the Muxus backend. */
export function localProbeRunner(platform: NodeJS.Platform = process.platform): ProbeRunner {
  if (platform === 'win32') return windowsProbeRunner;
  return async (probes) => {
    if (probes.length === 0) return new Map();
    const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const output = collect(child.stdout, () => child.kill());
    child.once('error', () => child.stdout.destroy());
    child.stdin.on('error', () => {});
    child.stdin.end(probeScript(probes));
    return parseProbeOutput(await output);
  };
}

/** Windows has no sh: each probe runs on its own, side by side. */
const windowsProbeRunner: ProbeRunner = async (probes) => {
  const entries = await Promise.all(
    probes.map(
      (probe) =>
        new Promise<[string, ProbeResult]>((resolve) => {
          const [file, ...args] = probe.argv;
          execFile(
            file!,
            args,
            {
              timeout: PROBE_TIMEOUT_SECONDS * 1000,
              maxBuffer: MAX_OUTPUT,
              windowsHide: true,
              encoding: 'utf8',
            },
            (error, stdout, stderr) => {
              if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                resolve([probe.id, { status: 'missing' }]);
                return;
              }
              const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
              resolve([probe.id, { status: 'ran', exitCode: code, stdout, stderr: stderr.trim() }]);
            },
          );
        }),
    ),
  );
  return new Map(entries);
};

/** Log lines from Go's klog (kubectl) and locale warnings: not the reason itself. */
const NOISE = /^(?:[IWEF]\d{4} \d\d:\d\d:\d\d|setlocale:|perl: warning:)/;

/** The tool's own words for why a probe failed, kept short enough for one row. */
export function probeFailure(result: ProbeResult | undefined): string | undefined {
  if (!result || result.status === 'missing') return undefined;
  if (result.exitCode === 0) return undefined;
  if (result.exitCode === 124) return 'did not answer in time';
  const lines = (result.stderr || result.stdout)
    .split('\n')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate && !NOISE.test(candidate));
  // Tools end with the sentence meant for people: kubectl's "The connection
  // to the server … was refused", virsh's "authentication unavailable".
  const line = lines.at(-1)?.replace(/^error:\s*/i, '') ?? `exit code ${result.exitCode}`;
  return line.length > 240 ? `${line.slice(0, 237)}…` : line;
}

/** stdout of a probe that ran and succeeded. */
export function probeOutput(result: ProbeResult | undefined): string | undefined {
  return result?.status === 'ran' && result.exitCode === 0 ? result.stdout : undefined;
}
