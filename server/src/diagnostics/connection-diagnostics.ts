import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import type {
  ConnectionCheck,
  ConnectionDiagnosticsResponse,
  TelnetProfile,
} from '@muxus/shared';
import { expandedProxyCommand, type ChainHop } from '../ssh/connection-manager.js';
import { probeAgentKeys, resolveAgentSocket } from '../ssh/key-scan.js';

/**
 * Cheap checks behind a failed session's "diagnose" key: they need no
 * privileges and no extra tools beyond the system `ping`, so they behave the
 * same on Windows, macOS and Linux. Each layer — name resolution, ICMP, TCP,
 * the service's greeting — explains a different class of failure, and the
 * lowest one that fails names the likely cause.
 */

const LOOKUP_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;
const GREETING_TIMEOUT_MS = 3_000;
const PING_TIMEOUT_MS = 3_000;
/** Addresses past this are listed by the DNS row but not dialed. */
const MAX_DIALED_ADDRESSES = 3;
const MAX_LISTED_ADDRESSES = 3;
/** RFC 4253 lets a server send other lines before its identification string. */
const GREETING_MAX_BYTES = 2_048;
const MAX_QUOTED_CHARS = 80;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type PingResult =
  /** `rtt` keeps the command's own precision, such as "0.42 ms" or "<1 ms". */
  | { status: 'reply'; rtt?: string }
  | { status: 'no-reply' }
  | { status: 'unavailable'; reason: string };

export type Greeting =
  | { kind: 'ssh'; banner: string }
  | { kind: 'other'; text: string }
  | { kind: 'closed' }
  | { kind: 'silent' };

export interface TcpProbe {
  address: ResolvedAddress;
  outcome: 'connected' | 'refused' | 'timeout' | 'unreachable' | 'error';
  ms?: number;
  /** Error code or message for `error`. */
  error?: string;
  greeting?: Greeting;
}

/** The I/O behind the checks; tests replace the parts that leave the machine. */
export interface DiagnosticProbes {
  lookup(host: string): Promise<ResolvedAddress[]>;
  ping(address: ResolvedAddress): Promise<PingResult>;
  connect(address: ResolvedAddress, port: number, readGreeting: boolean): Promise<TcpProbe>;
  agent(socket: string): Promise<{ available: boolean; keys: number }>;
  readable(file: string): Promise<'ok' | 'missing' | 'unreadable'>;
}

export const systemProbes: DiagnosticProbes = {
  async lookup(host) {
    const found = await dns.lookup(host, { all: true });
    return found.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
  },
  ping: systemPing,
  connect: (address, port, readGreeting) =>
    probeTcp(address, port, {
      readGreeting,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      greetingTimeoutMs: GREETING_TIMEOUT_MS,
    }),
  async agent(socket) {
    const probe = await probeAgentKeys(socket);
    return { available: probe.available, keys: probe.keys.length };
  },
  async readable(file) {
    try {
      await fs.access(file, fs.constants.R_OK);
      return 'ok';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    }
  },
};

// --- ping -------------------------------------------------------------------

/** The system ping for one echo request, bounded to about two seconds. */
export function pingInvocation(
  address: ResolvedAddress,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    return { file: 'ping', args: ['-n', '1', '-w', '2000', address.address] };
  }
  if (platform === 'darwin' || platform === 'freebsd') {
    // macOS keeps IPv6 in a separate ping6, whose wait option differs.
    return address.family === 6
      ? { file: 'ping6', args: ['-c', '1', address.address] }
      : { file: 'ping', args: ['-c', '1', '-t', '2', address.address] };
  }
  // iputils, BusyBox and inetutils all take -W in seconds.
  return { file: 'ping', args: ['-c', '1', '-W', '2', address.address] };
}

/**
 * Read a ping run by its exit code, which every platform sets the same way
 * for "got a reply", and take the round trip from the first "=12 ms" or
 * "<1ms" in the output, which survives translated output.
 */
export function readPingResult(
  run: { exitCode: number | null; output: string },
  address: ResolvedAddress,
  platform: NodeJS.Platform = process.platform,
): PingResult {
  // Windows exits 0 when a router answers "destination host unreachable";
  // only a real IPv4 echo reply carries a TTL.
  const replied =
    run.exitCode === 0 &&
    (platform !== 'win32' || address.family === 6 || /\bTTL[=:]/i.test(run.output));
  if (replied) {
    const time = /([=<])\s*(\d+(?:[.,]\d+)?)\s*ms\b/i.exec(run.output);
    return time
      ? { status: 'reply', rtt: `${time[1] === '<' ? '<' : ''}${time[2]} ms` }
      : { status: 'reply' };
  }
  const refusal = /not permitted|permission denied|socket:|usage:|invalid option|unknown option/i;
  if (refusal.test(run.output)) {
    return { status: 'unavailable', reason: firstLine(run.output) };
  }
  return { status: 'no-reply' };
}

function systemPing(address: ResolvedAddress): Promise<PingResult> {
  const { file, args } = pingInvocation(address);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: PING_TIMEOUT_MS,
        windowsHide: true,
        // English output where the platform honours it; the parser does not need it.
        env: { ...process.env, LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ status: 'unavailable', reason: `${file} is not installed` });
          return;
        }
        if (err?.killed) {
          resolve({ status: 'no-reply' });
          return;
        }
        const exitCode = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve(readPingResult({ exitCode, output: `${stdout}\n${stderr}` }, address));
      },
    );
  });
}

// --- TCP and greeting -------------------------------------------------------

const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN']);

/**
 * Open one TCP connection and, for SSH, wait for the server's identification
 * line. Nothing is sent: the server greets first, and closing before our own
 * identification leaves only a pre-auth disconnect in its log.
 */
export function probeTcp(
  address: ResolvedAddress,
  port: number,
  opts: { readGreeting: boolean; connectTimeoutMs: number; greetingTimeoutMs: number },
): Promise<TcpProbe> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host: address.address, port, family: address.family });
    let connectedMs: number | undefined;
    let received = Buffer.alloc(0);
    let settled = false;

    const finish = (probe: Omit<TcpProbe, 'address'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ address, ...probe });
    };
    const connected = (greeting?: Greeting) =>
      finish({ outcome: 'connected', ms: connectedMs, ...(greeting ? { greeting } : {}) });

    let timer = setTimeout(() => finish({ outcome: 'timeout' }), opts.connectTimeoutMs);
    socket.once('connect', () => {
      connectedMs = Math.round(performance.now() - started);
      clearTimeout(timer);
      if (!opts.readGreeting) {
        connected();
        return;
      }
      timer = setTimeout(
        () => connected(readGreeting(received, 'silent')),
        opts.greetingTimeoutMs,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]).subarray(0, GREETING_MAX_BYTES);
      const greeting = readGreeting(received, received.length >= GREETING_MAX_BYTES ? 'full' : undefined);
      if (greeting) connected(greeting);
    });
    socket.once('close', () => {
      if (connectedMs !== undefined) connected(readGreeting(received, 'closed'));
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (connectedMs !== undefined) return; // 'close' follows with what was read
      const code = err.code ?? '';
      if (code === 'ECONNREFUSED') finish({ outcome: 'refused' });
      else if (code === 'ETIMEDOUT') finish({ outcome: 'timeout' });
      else if (UNREACHABLE_CODES.has(code)) finish({ outcome: 'unreachable', error: code });
      else finish({ outcome: 'error', error: code || err.message });
    });
  });
}

/**
 * The SSH identification line among what the server sent, or — once reading
 * is over (`end`: the server closed, went quiet, or sent too much) — what it
 * sent instead. Undefined while still undecided.
 */
export function readGreeting(
  received: Buffer,
  end?: 'closed' | 'silent' | 'full',
): Greeting | undefined {
  const text = received.toString('latin1');
  const lines = text.split('\n');
  for (const line of lines.slice(0, -1)) {
    if (line.startsWith('SSH-')) return { kind: 'ssh', banner: printable(line) };
  }
  if (!end) return undefined;
  const partial = lines.at(-1) ?? '';
  if (partial.startsWith('SSH-')) return { kind: 'ssh', banner: printable(partial) };
  if (!received.length) return end === 'closed' ? { kind: 'closed' } : { kind: 'silent' };
  return { kind: 'other', text: printable(text.trimStart().split('\n')[0] ?? '') || 'binary data' };
}

function printable(text: string): string {
  const clean = text.replace(/[^\x20-\x7e]+/g, ' ').trim();
  return clean.length > MAX_QUOTED_CHARS ? `${clean.slice(0, MAX_QUOTED_CHARS - 1)}…` : clean;
}

function firstLine(text: string): string {
  return printable(text.trim().split('\n')[0] ?? '');
}

// --- one endpoint -----------------------------------------------------------

export function hostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

interface EndpointDiagnosis {
  checks: ConnectionCheck[];
  /** Set when a layer failed; undefined when the service answered as expected. */
  conclusion?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolve, ping, dial and — for SSH — read the greeting of one host:port. */
export async function diagnoseEndpoint(
  endpoint: { host: string; port: number; service: 'ssh' | 'telnet' },
  probes: DiagnosticProbes,
): Promise<EndpointDiagnosis> {
  const { host, port, service } = endpoint;
  const checks: ConnectionCheck[] = [];

  let addresses: ResolvedAddress[];
  const literal = net.isIP(host);
  if (literal) {
    addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  } else {
    const started = performance.now();
    let failure: string | undefined;
    try {
      const found = await withTimeout(probes.lookup(host), LOOKUP_TIMEOUT_MS);
      if (found === 'timeout') {
        failure = `no answer for ${host} within ${LOOKUP_TIMEOUT_MS / 1000} s`;
        addresses = [];
      } else {
        addresses = found;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      failure =
        code === 'ENOTFOUND' || code === 'ENODATA'
          ? `${host} does not resolve`
          : code === 'EAI_AGAIN'
            ? `the DNS server did not answer for ${host}`
            : `${host}: ${code ?? (err as Error).message}`;
      addresses = [];
    }
    if (failure || !addresses.length) {
      checks.push({ label: 'DNS', status: 'fail', detail: failure ?? `${host} has no addresses` });
      return {
        checks,
        conclusion: `${host} does not resolve from this computer. Check the host name, the DNS settings, or connect the VPN whose DNS knows it.`,
      };
    }
    const listed = addresses.slice(0, MAX_LISTED_ADDRESSES).map((a) => a.address).join(', ');
    const more = addresses.length > MAX_LISTED_ADDRESSES ? ` +${addresses.length - MAX_LISTED_ADDRESSES} more` : '';
    checks.push({
      label: 'DNS',
      status: 'ok',
      detail: `${host} → ${listed}${more} (${Math.round(performance.now() - started)} ms)`,
    });
  }

  const dialed = addresses.slice(0, MAX_DIALED_ADDRESSES);
  const [ping, ...tcp] = await Promise.all([
    probes.ping(dialed[0]!),
    ...dialed.map((address) => probes.connect(address, port, service === 'ssh')),
  ]);

  const pinged = dialed[0]!.address;
  checks.push(
    ping.status === 'reply'
      ? { label: 'Ping', status: 'ok', detail: `${pinged} replied${ping.rtt ? ` in ${ping.rtt}` : ''}` }
      : ping.status === 'no-reply'
        ? { label: 'Ping', status: 'warn', detail: `${pinged} did not reply (many hosts and firewalls drop ping)` }
        : { label: 'Ping', status: 'skipped', detail: `could not run ping: ${ping.reason}` },
  );

  const open = tcp.find((probe) => probe.outcome === 'connected');
  for (const probe of tcp) {
    const where = hostPort(probe.address.address, port);
    if (probe.outcome === 'connected') {
      checks.push({ label: 'TCP', status: 'ok', detail: `${where} connected in ${probe.ms ?? 0} ms` });
      continue;
    }
    // Clients fall back to the next address, so one dead address is only a
    // warning — and a family this computer has no network for is not news.
    const noNetwork = probe.error === 'ENETUNREACH';
    const status = !open ? 'fail' : noNetwork ? 'info' : 'warn';
    const detail =
      probe.outcome === 'refused'
        ? `${where} refused the connection`
        : probe.outcome === 'timeout'
          ? `${where} did not answer within ${CONNECT_TIMEOUT_MS / 1000} s`
          : noNetwork
            ? `${where}: this computer has no route to IPv${probe.address.family} networks`
            : probe.outcome === 'unreachable'
              ? `${where}: no route to the host (${probe.error})`
              : `${where}: ${probe.error}`;
    checks.push({ label: 'TCP', status, detail });
  }

  if (!open) {
    // An address without a route says nothing about the others.
    const routed = tcp.filter((probe) => probe.outcome !== 'unreachable');
    const outcomes = new Set(routed.map((probe) => probe.outcome));
    const conclusion = !routed.length
      ? `There is no network route to ${host}. Check the network connection and VPN.`
      : outcomes.size === 1 && outcomes.has('refused')
        ? `${host} is up but nothing accepts connections on port ${port}. Is the ${service === 'ssh' ? 'SSH' : 'Telnet'} server running on that port?`
        : outcomes.has('timeout') && ping.status === 'reply'
          ? `${host} answers ping, but port ${port} does not answer. A firewall is probably dropping the connection.`
          : outcomes.has('timeout')
            ? `${host} does not answer from this computer. It may be down, or reachable only through a VPN or a jump host.`
            : `Could not open a connection to ${hostPort(host, port)} (${routed[0]?.error ?? 'unknown error'}).`;
    return { checks, conclusion };
  }

  if (service !== 'ssh') return { checks };

  const greeting = open.greeting ?? { kind: 'silent' };
  const where = hostPort(open.address.address, port);
  if (greeting.kind === 'ssh') {
    checks.push({ label: 'SSH', status: 'ok', detail: greeting.banner });
    return { checks };
  }
  if (greeting.kind === 'other') {
    checks.push({ label: 'SSH', status: 'fail', detail: `${where} answered "${greeting.text}"` });
    return {
      checks,
      conclusion: `Port ${port} answers, but not with SSH. Check the port number.`,
    };
  }
  if (greeting.kind === 'closed') {
    checks.push({ label: 'SSH', status: 'fail', detail: `${where} closed the connection without a greeting` });
    return {
      checks,
      conclusion:
        'The server accepted the connection and closed it before greeting. SSH servers do this when MaxStartups is reached, or when TCP wrappers, fail2ban or an allow list reject this address.',
    };
  }
  checks.push({
    label: 'SSH',
    status: 'fail',
    detail: `${where} sent no greeting within ${GREETING_TIMEOUT_MS / 1000} s`,
  });
  return {
    checks,
    conclusion: `Port ${port} accepts the connection but sends no SSH greeting. Another service, or a firewall or load balancer that holds connections open, may be in the way.`,
  };
}

// --- sessions ---------------------------------------------------------------

function tilde(file: string): string {
  const home = os.homedir();
  return file === home || file.startsWith(`${home}/`) || file.startsWith(`${home}\\`)
    ? `~${file.slice(home.length)}`
    : file;
}

function describeRoute(chain: readonly ChainHop[]): string {
  const target = chain.at(-1)!;
  const endpoint = `${target.user}@${hostPort(target.resolved.hostname, target.port)}`;
  const parts = [
    target.spec.host === target.resolved.hostname ? endpoint : `${target.spec.host} → ${endpoint}`,
  ];
  const jumps = chain.slice(0, -1).map((hop) => hop.spec.host);
  if (jumps.length) parts.push(`via ${jumps.join(' → ')}`);
  if (chain[0]!.resolved.proxyCommand) parts.push('through a ProxyCommand');
  return parts.join(' ');
}

/** Agent and key-file rows; returns the configured key files that are missing. */
async function authChecks(
  chain: readonly ChainHop[],
  probes: DiagnosticProbes,
): Promise<{ checks: ConnectionCheck[]; missingKeys: string[] }> {
  const checks: ConnectionCheck[] = [];
  const keyHops = chain.filter((hop) => !hop.resolved.passwordOnly);
  if (!keyHops.length) return { checks, missingKeys: [] };

  const identityAgent = chain.at(-1)!.resolved.identityAgent;
  if (identityAgent?.toLowerCase() !== 'none') {
    const socket = resolveAgentSocket(identityAgent);
    if (!socket) {
      checks.push({ label: 'Agent', status: 'info', detail: 'no SSH agent configured (SSH_AUTH_SOCK is not set)' });
    } else {
      const agent = await probes.agent(socket);
      // The Windows pipe is only a default; an agent nobody asked for is not a problem.
      const expected = identityAgent !== undefined || !!process.env.SSH_AUTH_SOCK;
      checks.push(
        !agent.available
          ? { label: 'Agent', status: expected ? 'warn' : 'info', detail: `no agent answered at ${tilde(socket)}` }
          : agent.keys === 0
            ? { label: 'Agent', status: 'warn', detail: 'the agent is running but holds no keys' }
            : { label: 'Agent', status: 'ok', detail: `${agent.keys} ${agent.keys === 1 ? 'key' : 'keys'} loaded` },
      );
    }
  }

  const files = [...new Set(keyHops.flatMap((hop) => hop.resolved.identityFiles))];
  const states = await Promise.all(files.map(async (file) => [file, await probes.readable(file)] as const));
  const problems = states.filter(([, state]) => state !== 'ok');
  if (files.length) {
    checks.push(
      problems.length
        ? {
            label: 'Key files',
            status: 'warn',
            detail: problems
              .map(([file, state]) => `${tilde(file)} ${state === 'missing' ? 'not found' : 'not readable'}`)
              .join('; '),
          }
        : {
            label: 'Key files',
            status: 'ok',
            detail: `${files.length} configured ${files.length === 1 ? 'file' : 'files'} found`,
          },
    );
  }
  return { checks, missingKeys: problems.map(([file]) => tilde(file)) };
}

/** Diagnose an SSH session from its dial plan: the first hop is the only one in reach. */
export async function diagnoseSsh(
  chain: readonly ChainHop[],
  probes: DiagnosticProbes = systemProbes,
): Promise<ConnectionDiagnosticsResponse> {
  const first = chain[0]!;
  const target = chain.at(-1)!;
  const checked = hostPort(first.resolved.hostname, first.port);
  const checks: ConnectionCheck[] = [{ label: 'Route', status: 'info', detail: describeRoute(chain) }];

  let conclusion: string | undefined;
  const proxyCommand = expandedProxyCommand(first);
  if (proxyCommand) {
    checks.push({
      label: 'Network',
      status: 'skipped',
      detail: `${first.spec.host} is reached through its ProxyCommand, not over a direct connection`,
    });
    conclusion = `Muxus cannot test a ProxyCommand on its own. Run it in a terminal to see its errors: ${proxyCommand}`;
  } else {
    const network = await diagnoseEndpoint(
      { host: first.resolved.hostname, port: first.port, service: 'ssh' },
      probes,
    );
    checks.push(...network.checks);
    if (network.conclusion) return { checked, checks, conclusion: network.conclusion };
  }

  const auth = await authChecks(chain, probes);
  checks.push(...auth.checks);
  if (conclusion) return { checked, checks, conclusion };

  if (auth.missingKeys.length) {
    conclusion = `The SSH server answers, but configured key files are missing (${auth.missingKeys.join(', ')}). Authentication fails without them unless another method is accepted.`;
  } else if (chain.length > 1) {
    conclusion = `${first.spec.host} is reachable and speaks SSH. ${target.spec.host} is dialed through it and cannot be checked from this computer; the failure reason above names the hop that failed.`;
  } else {
    conclusion =
      'The network path and the SSH server are fine, so the session failed after the greeting: at authentication, the host key, or a server-side limit. The failure reason above has the details.';
  }
  return { checked, checks, conclusion };
}

export async function diagnoseTelnet(
  profile: Pick<TelnetProfile, 'host' | 'port'>,
  probes: DiagnosticProbes = systemProbes,
): Promise<ConnectionDiagnosticsResponse> {
  const checked = hostPort(profile.host, profile.port);
  const network = await diagnoseEndpoint(
    { host: profile.host, port: profile.port, service: 'telnet' },
    probes,
  );
  return {
    checked,
    checks: network.checks,
    conclusion:
      network.conclusion ??
      `${checked} accepts connections, so the network path is fine. The session failed after connecting; the failure reason above has the details.`,
  };
}
