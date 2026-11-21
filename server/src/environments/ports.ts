import type { ListeningPort, ListeningPortsResponse } from '@muxus/shared';
import { probeFailure, probeOutput, type ProbeRunner } from './probe-runner.js';

/**
 * TCP ports a host listens on, with the program behind each where the host
 * says. `ss` answers on any current Linux; hosts without it are asked with
 * netstat (net-tools, BusyBox) and lsof (macOS, the BSDs).
 */

/** No `-H`: iproute2 before 4.12 (CentOS 7) refuses it, and the header is easy to skip. */
const SS_PROBE = { id: 'ss', argv: ['ss', '-tlnp'] };
const FALLBACK_PROBES = [
  // -p names the program on Linux; BusyBox builds without it, and macOS reads it differently.
  { id: 'netstat-programs', argv: ['netstat', '-tlnp'] },
  { id: 'lsof', argv: ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN'] },
  { id: 'netstat', argv: ['netstat', '-tln'] },
  { id: 'netstat-all', argv: ['netstat', '-an'] },
];

interface Listener {
  address: string;
  port: number;
  process?: string;
  pid?: number;
}

/** Zone names and brackets off, the two "every address" spellings told apart by family. */
function cleanAddress(raw: string): string {
  // ss writes the zone after the bracket: `[fe80::1]%eth0`.
  const address = raw.replace(/%[^\]]*$/, '').replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
  if (address === '' || address === '*') return '*';
  // An IPv4 listener seen through a dual-stack socket.
  return address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
}

/** `addr:port`, `[addr]:port`, `[addr]%zone:port` and BSD's `addr.port`. */
function splitEndpoint(endpoint: string, separator: ':' | '.'): { address: string; port: number } | undefined {
  const at = endpoint.lastIndexOf(separator);
  if (at < 0) return undefined;
  const port = Number(endpoint.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { address: cleanAddress(endpoint.slice(0, at)), port };
}

/**
 * `ss -tlnp`: State Recv-Q Send-Q Local Peer [Process]. The process column
 * is `users:(("nginx",pid=812,fd=6),…)` and missing for sockets of other
 * users unless ss runs as root.
 */
export function parseSs(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'LISTEN' || fields.length < 5) continue;
    const endpoint = splitEndpoint(fields[3]!, ':');
    if (!endpoint) continue;
    const user = /users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(line);
    listeners.push({
      ...endpoint,
      ...(user ? { process: user[1]!.replace(/\\(.)/g, '$1'), pid: Number(user[2]) } : {}),
    });
  }
  return listeners;
}

/**
 * netstat, as net-tools and BusyBox print it (`tcp 0 0 0.0.0.0:22 0.0.0.0:*
 * LISTEN 812/sshd`), as the BSDs and macOS do (`tcp4 0 0 *.22 *.* LISTEN`)
 * and as Windows does (`TCP 0.0.0.0:135 0.0.0.0:0 LISTENING`).
 */
export function parseNetstat(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (!/^tcp/i.test(fields[0] ?? '')) continue;
    // Windows writes LISTENING, and has no queue columns before the addresses.
    const state = fields.findIndex((field) => field === 'LISTEN' || field === 'LISTENING');
    if (state < 2) continue;
    const local = fields[state - 2]!;
    // Linux and Windows put a colon before the port, the BSDs a dot.
    const endpoint = splitEndpoint(local, /\.\d+$/.test(local) ? '.' : ':');
    if (!endpoint) continue;
    const program = /^(\d+)\/(.+)$/.exec(fields.slice(state + 1).join(' '));
    listeners.push({
      ...endpoint,
      ...(program ? { process: program[2]!.trim(), pid: Number(program[1]) } : {}),
    });
  }
  return listeners;
}

/** `lsof -nP -iTCP -sTCP:LISTEN`: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN). */
export function parseLsof(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split('\n')) {
    const match = /^(\S+)\s+(\d+)\s.*\sTCP\s+(\S+)\s+\(LISTEN\)\s*$/.exec(line);
    if (!match) continue;
    const endpoint = splitEndpoint(match[3]!, ':');
    if (!endpoint) continue;
    // lsof writes a space in a program name as \x20.
    const process = match[1]!.replace(/\\x([0-9a-f]{2})/gi, (_all, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    listeners.push({ ...endpoint, process, pid: Number(match[2]) });
  }
  return listeners;
}

function addressOrder(address: string): number {
  if (address === '*' || address === '0.0.0.0') return 0;
  if (address === '::') return 1;
  return address.includes(':') ? 3 : 2;
}

/**
 * One entry per port and program: a service listening on IPv4 and IPv6, or
 * on several addresses, is still one service.
 */
export function mergeListeners(listeners: readonly Listener[]): ListeningPort[] {
  const ports = new Map<string, ListeningPort>();
  for (const listener of listeners) {
    const key = `${listener.port}\n${listener.process ?? ''}`;
    const known = ports.get(key);
    if (known) {
      if (!known.addresses.includes(listener.address)) known.addresses.push(listener.address);
      known.pid ??= listener.pid;
      continue;
    }
    ports.set(key, {
      port: listener.port,
      addresses: [listener.address],
      ...(listener.process ? { process: listener.process } : {}),
      ...(listener.pid !== undefined ? { pid: listener.pid } : {}),
    });
  }
  // A socket whose program is hidden is the same service as a named one on that port.
  for (const [key, entry] of ports) {
    if (entry.process) continue;
    const named = [...ports.values()].find((other) => other.port === entry.port && other.process);
    if (!named) continue;
    for (const address of entry.addresses) {
      if (!named.addresses.includes(address)) named.addresses.push(address);
    }
    ports.delete(key);
  }
  return [...ports.values()]
    .map((entry) => ({
      ...entry,
      addresses: entry.addresses.sort((a, b) => addressOrder(a) - addressOrder(b) || a.localeCompare(b)),
    }))
    .sort((a, b) => a.port - b.port || (a.process ?? '').localeCompare(b.process ?? ''));
}

/** The listening TCP ports of the host behind `run`, from the first tool that answers. */
export async function listeningPorts(run: ProbeRunner): Promise<ListeningPortsResponse> {
  const first = await run([SS_PROBE]);
  const ss = probeOutput(first.get('ss'));
  if (ss !== undefined) return { status: 'ok', tool: 'ss', ports: mergeListeners(parseSs(ss)) };

  const results = await run(FALLBACK_PROBES);
  const programs = probeOutput(results.get('netstat-programs'));
  if (programs !== undefined) {
    return { status: 'ok', tool: 'netstat', ports: mergeListeners(parseNetstat(programs)) };
  }
  const lsof = results.get('lsof');
  if (lsof?.status === 'ran') {
    const listeners = parseLsof(lsof.stdout);
    // lsof exits 1 when nothing listens, and also beside a full list it had a warning about.
    if (listeners.length > 0 || lsof.exitCode === 0 || !lsof.stdout.trim()) {
      return { status: 'ok', tool: 'lsof', ports: mergeListeners(listeners) };
    }
  }
  for (const id of ['netstat', 'netstat-all']) {
    const plain = probeOutput(results.get(id));
    if (plain === undefined) continue;
    return { status: 'ok', tool: 'netstat', ports: mergeListeners(parseNetstat(plain)) };
  }
  const reason =
    probeFailure(first.get('ss')) ??
    FALLBACK_PROBES.map((probe) => probeFailure(results.get(probe.id))).find(Boolean);
  return {
    status: 'unavailable',
    message: reason ? `Could not list ports: ${reason}` : 'The host has no ss, netstat or lsof to list ports with.',
  };
}
