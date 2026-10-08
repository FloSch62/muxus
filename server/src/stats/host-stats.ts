import { spawn } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Client, ClientChannel } from 'ssh2';
import type { HostStatsSample } from '@muxus/shared';

/**
 * Status bar statistics, read by running one fixed POSIX sh script: over an
 * exec channel on the live SSH transport, or locally for local terminals.
 * Nothing is installed or left behind on the host.
 *
 * The script only prints raw sources under `@@muxus:<name>` markers; all
 * interpretation happens in {@link parseHostStats}, where it can be tested.
 * Linux reports everything from /proc; macOS and the BSDs fall back to
 * sysctl, vm_stat, route and netstat for what they have.
 */
export const HOST_STATS_SCRIPT = `LC_ALL=C
PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin"
export LC_ALL PATH
muxus_section() { printf '\\n@@muxus:%s\\n' "$1"; }
muxus_section begin
muxus_section hostname; uname -n 2>/dev/null
muxus_section kernel; uname -sr 2>/dev/null
muxus_section os-release; grep -E '^(PRETTY_NAME|NAME|VERSION_ID)=' /etc/os-release 2>/dev/null
muxus_section who; who 2>/dev/null
muxus_section df; df -P -k / 2>/dev/null
if [ -r /proc/stat ]; then
  muxus_section uptime; cat /proc/uptime 2>/dev/null
  muxus_section stat; head -n 1 /proc/stat 2>/dev/null; grep -c '^cpu[0-9]' /proc/stat 2>/dev/null
  muxus_section loadavg; cat /proc/loadavg 2>/dev/null
  muxus_section meminfo; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
  muxus_section route; cat /proc/net/route 2>/dev/null
  muxus_section netdev; cat /proc/net/dev 2>/dev/null
else
  muxus_section sw-vers; sw_vers 2>/dev/null
  muxus_section now; date +%s 2>/dev/null
  muxus_section boottime; sysctl -n kern.boottime 2>/dev/null
  muxus_section bsd-loadavg; sysctl -n vm.loadavg 2>/dev/null
  muxus_section ncpu; sysctl -n hw.ncpu 2>/dev/null
  muxus_section memsize; sysctl -n hw.memsize 2>/dev/null
  muxus_section vm-stat; vm_stat 2>/dev/null
  muxus_section bsd-route; route -n get default 2>/dev/null
  muxus_section netstat; netstat -ibn 2>/dev/null
fi
muxus_section end
`;

const SCRIPT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 256 * 1024;

export type HostStatsReading =
  | { supported: true; sample: HostStatsSample }
  /** The probe printed none of its markers: no POSIX shell answered it. */
  | { supported: false };

/** Split script output into its marked sections; text before the first marker is dropped. */
function sections(output: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of output.split(/\r?\n/)) {
    const marker = /^@@muxus:([a-z-]+)$/.exec(line.trim());
    if (marker) {
      current = [];
      result.set(marker[1]!, current);
    } else if (current && line.trim()) {
      current.push(line);
    }
  }
  return result;
}

function finite(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function osReleaseName(lines: readonly string[]): string | undefined {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) fields.set(match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, '$2').trim());
  }
  const pretty = fields.get('PRETTY_NAME');
  if (pretty) return pretty;
  const name = fields.get('NAME');
  if (!name) return undefined;
  const version = fields.get('VERSION_ID');
  return version ? `${name} ${version}` : name;
}

function swVersName(lines: readonly string[]): string | undefined {
  const field = (key: string) =>
    lines.map((line) => new RegExp(`^${key}:\\s*(.+)$`).exec(line.trim())?.[1]).find(Boolean);
  const name = field('ProductName');
  if (!name) return undefined;
  const version = field('ProductVersion');
  return version ? `${name} ${version}` : name;
}

/** First line of /proc/stat: user nice system idle iowait irq softirq steal [guest guest_nice]. */
function procCpuTime(line: string | undefined): HostStatsSample['cpuTime'] {
  const fields = line?.trim().split(/\s+/);
  if (fields?.[0] !== 'cpu') return undefined;
  // guest time is already part of user and nice, so it is not added again.
  const times = fields.slice(1, 9).map(Number);
  if (times.length < 4 || times.some((time) => !Number.isFinite(time))) return undefined;
  const total = times.reduce((sum, time) => sum + time, 0);
  const idle = times[3]! + (times[4] ?? 0);
  return { total, idle };
}

function loadAverage(line: string | undefined): HostStatsSample['loadAverage'] {
  const values = line
    ?.replace(/[{}]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map(Number);
  if (values?.length !== 3 || values.some((value) => !Number.isFinite(value))) return undefined;
  return [values[0]!, values[1]!, values[2]!];
}

function procMemory(lines: readonly string[]): HostStatsSample['memory'] {
  const kib = new Map<string, number>();
  for (const line of lines) {
    const match = /^(\w+):\s+(\d+)/.exec(line.trim());
    if (match) kib.set(match[1]!, Number(match[2]));
  }
  const total = kib.get('MemTotal');
  if (!total) return undefined;
  // MemAvailable arrived in Linux 3.14; older kernels get the classic estimate.
  const available =
    kib.get('MemAvailable') ??
    (kib.get('MemFree') ?? 0) + (kib.get('Buffers') ?? 0) + (kib.get('Cached') ?? 0);
  const swapTotal = kib.get('SwapTotal');
  const swapFree = kib.get('SwapFree');
  return {
    totalBytes: total * 1024,
    availableBytes: Math.min(available, total) * 1024,
    ...(swapTotal !== undefined ? { swapTotalBytes: swapTotal * 1024 } : {}),
    ...(swapFree !== undefined ? { swapFreeBytes: swapFree * 1024 } : {}),
  };
}

/** macOS: hw.memsize plus vm_stat pages; free, inactive and speculative pages count as available. */
function vmStatMemory(
  memsize: string | undefined,
  lines: readonly string[],
): HostStatsSample['memory'] {
  const total = finite(memsize?.trim());
  if (!total) return undefined;
  const pageSize = finite(/page size of (\d+) bytes/.exec(lines[0] ?? '')?.[1]);
  if (!pageSize) return undefined;
  const pages = (name: string) =>
    finite(
      lines
        .map((line) => new RegExp(`^Pages ${name}:\\s+(\\d+)`).exec(line.trim())?.[1])
        .find(Boolean),
    ) ?? 0;
  const available = (pages('free') + pages('inactive') + pages('speculative')) * pageSize;
  return { totalBytes: total, availableBytes: Math.min(available, total) };
}

/** The interface of the default route in /proc/net/route, if there is one. */
function procDefaultInterface(lines: readonly string[]): string | undefined {
  for (const line of lines.slice(1)) {
    const [iface, destination, , , , , , mask] = line.trim().split(/\s+/);
    if (iface && destination === '00000000' && (mask === undefined || mask === '00000000')) {
      return iface;
    }
  }
  return undefined;
}

/**
 * Byte counters from /proc/net/dev for the default-route interface. Without
 * a default route, the busiest interface other than loopback stands in.
 */
function procNetwork(
  lines: readonly string[],
  defaultInterface: string | undefined,
): HostStatsSample['network'] {
  const counters: Array<{ interface: string; receivedBytes: number; sentBytes: number }> = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    const receivedBytes = fields[0];
    const sentBytes = fields[8];
    if (!name || receivedBytes === undefined || sentBytes === undefined) continue;
    if (!Number.isFinite(receivedBytes) || !Number.isFinite(sentBytes)) continue;
    counters.push({ interface: name, receivedBytes, sentBytes });
  }
  return pickInterface(counters, defaultInterface);
}

/**
 * `netstat -ibn` (macOS, BSD): the `<Link#n>` row carries an interface's
 * totals. Rows can lack the Address column, so the byte columns are found by
 * their distance from the end of the header.
 */
function netstatNetwork(
  lines: readonly string[],
  defaultInterface: string | undefined,
): HostStatsSample['network'] {
  const header = lines[0]?.trim().split(/\s+/);
  if (!header) return undefined;
  const fromEnd = (column: string) => {
    const index = header.indexOf(column);
    return index < 0 ? undefined : header.length - index;
  };
  const received = fromEnd('Ibytes');
  const sent = fromEnd('Obytes');
  if (received === undefined || sent === undefined) return undefined;
  const counters: Array<{ interface: string; receivedBytes: number; sentBytes: number }> = [];
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (!fields[2]?.startsWith('<Link')) continue;
    const receivedBytes = Number(fields[fields.length - received]);
    const sentBytes = Number(fields[fields.length - sent]);
    if (!Number.isFinite(receivedBytes) || !Number.isFinite(sentBytes)) continue;
    counters.push({ interface: fields[0]!.replace(/\*$/, ''), receivedBytes, sentBytes });
  }
  return pickInterface(counters, defaultInterface);
}

function pickInterface(
  counters: ReadonlyArray<{ interface: string; receivedBytes: number; sentBytes: number }>,
  defaultInterface: string | undefined,
): HostStatsSample['network'] {
  const preferred = counters.find((entry) => entry.interface === defaultInterface);
  if (preferred) return preferred;
  return counters
    .filter((entry) => !/^lo\d*$/.test(entry.interface))
    .reduce<HostStatsSample['network']>(
      (busiest, entry) =>
        !busiest || entry.receivedBytes > busiest.receivedBytes ? entry : busiest,
      undefined,
    );
}

function dfDisk(lines: readonly string[]): HostStatsSample['disk'] {
  for (const line of lines.slice(1)) {
    const match = /^.*?\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(\/.*)$/.exec(line.trim());
    if (!match) continue;
    return {
      mount: match[4]!,
      totalBytes: Number(match[1]) * 1024,
      usedBytes: Number(match[2]) * 1024,
      availableBytes: Number(match[3]) * 1024,
    };
  }
  return undefined;
}

/** Turn the script's output into a sample; `undefined` when no marker came back. */
export function parseHostStats(output: string): HostStatsSample | undefined {
  const parts = sections(output);
  if (!parts.has('begin')) return undefined;
  const first = (name: string) => parts.get(name)?.[0]?.trim();
  const lines = (name: string) => parts.get(name) ?? [];

  const sample: HostStatsSample = {};
  const hostname = first('hostname');
  if (hostname) sample.hostname = hostname;
  const kernel = first('kernel');
  if (kernel) sample.kernel = kernel;
  const osName = osReleaseName(lines('os-release')) ?? swVersName(lines('sw-vers')) ?? kernel;
  if (osName) sample.os = osName;

  const procUptime = finite(first('uptime')?.split(/\s+/)[0]);
  const bootSeconds = finite(/sec\s*=\s*(\d+)/.exec(first('boottime') ?? '')?.[1]);
  const now = finite(first('now'));
  const uptime =
    procUptime ?? (bootSeconds !== undefined && now !== undefined ? now - bootSeconds : undefined);
  if (uptime !== undefined && uptime >= 0) sample.uptimeSeconds = uptime;

  const stat = lines('stat');
  const cpuTime = procCpuTime(stat[0]);
  if (cpuTime) sample.cpuTime = cpuTime;
  const cores = finite(stat[1]?.trim()) ?? finite(first('ncpu'));
  if (cores && cores > 0) sample.cores = cores;
  const load = loadAverage(first('loadavg') ?? first('bsd-loadavg'));
  if (load) sample.loadAverage = load;

  const memory =
    procMemory(lines('meminfo')) ?? vmStatMemory(first('memsize'), lines('vm-stat'));
  if (memory) sample.memory = memory;

  const network = parts.has('netdev')
    ? procNetwork(lines('netdev'), procDefaultInterface(lines('route')))
    : netstatNetwork(
        lines('netstat'),
        /interface:\s*(\S+)/.exec(lines('bsd-route').join('\n'))?.[1],
      );
  if (network) sample.network = network;

  if (parts.has('who')) {
    sample.users = lines('who')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name): name is string => !!name);
  }
  const disk = dfDisk(lines('df'));
  if (disk) sample.disk = disk;
  return sample;
}

/** Collect a script run's stdout, giving up on a host that never finishes. */
function collectOutput(
  stream: NodeJS.ReadableStream,
  stop: () => void,
): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };
    const timer = setTimeout(() => {
      stop();
      finish();
    }, SCRIPT_TIMEOUT_MS);
    timer.unref();
    stream.on('data', (chunk: Buffer | string) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
    });
    stream.once('close', finish);
    stream.once('end', finish);
    stream.once('error', finish);
  });
}

/**
 * Read a remote host over its live transport. `sh -s` keeps the login shell
 * out of the script's syntax, so fish or tcsh users are covered too. Channel
 * failures (a refused exec, MaxSessions reached) reject; a host that answers
 * without the markers is reported as unsupported.
 */
export async function readRemoteHostStats(client: Client): Promise<HostStatsReading> {
  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    client.exec('sh -s', (error, stream) => (error ? reject(error) : resolve(stream)));
  });
  // Unread stderr would hold the channel window open on a chatty host.
  channel.stderr.resume();
  const output = collectOutput(channel, () => channel.destroy());
  channel.end(HOST_STATS_SCRIPT);
  const sample = parseHostStats(await output);
  return sample ? { supported: true, sample } : { supported: false };
}

/** CPU time summed over every core, from Node; the platform-neutral fallback. */
function nodeCpuTime(): Pick<HostStatsSample, 'cpuTime' | 'cores'> {
  const cpus = os.cpus();
  if (cpus.length === 0) return {};
  let total = 0;
  let idle = 0;
  for (const { times } of cpus) {
    total += times.user + times.nice + times.sys + times.idle + times.irq;
    idle += times.idle;
  }
  return { cpuTime: { total, idle }, cores: cpus.length };
}

/** Windows has no sh: everything comes from Node, and there is no `who` or byte counters. */
async function readWindowsHostStats(): Promise<HostStatsSample> {
  const drive = process.env.SystemDrive ?? 'C:';
  const [major, , build] = os.release().split('.').map(Number);
  // Windows 11 still names itself Windows 10 in the version string.
  const version =
    major === 10 && build !== undefined && build >= 22000
      ? os.version().replace(/^Windows 10\b/, 'Windows 11')
      : os.version();
  const sample: HostStatsSample = {
    hostname: os.hostname(),
    os: version,
    kernel: `${os.type()} ${os.release()}`,
    uptimeSeconds: os.uptime(),
    memory: { totalBytes: os.totalmem(), availableBytes: os.freemem() },
    ...nodeCpuTime(),
  };
  try {
    const stats = await statfs(`${drive}${path.win32.sep}`);
    sample.disk = {
      mount: drive,
      totalBytes: stats.blocks * stats.bsize,
      usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
      availableBytes: stats.bavail * stats.bsize,
    };
  } catch {
    // Leave the disk out rather than fail the whole reading.
  }
  return sample;
}

/** Read the machine local terminals run on: the computer running the Muxus backend. */
export async function readLocalHostStats(): Promise<HostStatsSample> {
  if (process.platform === 'win32') return readWindowsHostStats();
  const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const output = collectOutput(child.stdout, () => child.kill());
  child.once('error', () => child.stdout.destroy());
  child.stdin.on('error', () => {});
  child.stdin.end(HOST_STATS_SCRIPT);
  const sample = parseHostStats(await output) ?? {};
  // macOS has no cumulative CPU counters in the script; Node has them everywhere.
  if (!sample.cpuTime) Object.assign(sample, nodeCpuTime());
  sample.hostname ??= os.hostname();
  return sample;
}
