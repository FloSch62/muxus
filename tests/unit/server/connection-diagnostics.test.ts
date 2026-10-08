import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  diagnoseEndpoint,
  diagnoseSsh,
  diagnoseTelnet,
  pingInvocation,
  probeTcp,
  readGreeting,
  readPingResult,
  type DiagnosticProbes,
  type ResolvedAddress,
  type TcpProbe,
} from '../../../server/src/diagnostics/connection-diagnostics.js';
import { buildChain } from '../../../server/src/ssh/connection-manager.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-diagnostics-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

let counter = 0;
function chainOf(target: string, config: string[]) {
  const dir = path.join(tmp, `c-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config');
  writeFileSync(file, config.join('\n'));
  return buildChain(loadConfigDocument(file), { target });
}

const V4: ResolvedAddress = { address: '192.0.2.10', family: 4 };
const V6: ResolvedAddress = { address: '2001:db8::10', family: 6 };

/** Probes answering from a table; anything unlisted fails the test loudly. */
function fakeProbes(overrides: Partial<DiagnosticProbes> = {}): DiagnosticProbes {
  return {
    lookup: async () => [V4],
    ping: async () => ({ status: 'reply', rtt: '1.2 ms' }),
    connect: async (address) => ({
      address,
      outcome: 'connected',
      ms: 4,
      greeting: { kind: 'ssh', banner: 'SSH-2.0-OpenSSH_9.6' },
    }),
    agent: async () => ({ available: true, keys: 2 }),
    readable: async () => 'ok',
    ...overrides,
  };
}

function listen(onConnection: (socket: net.Socket) => void): Promise<net.Server & { port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.listen(0, '127.0.0.1', () => {
      resolve(Object.assign(server, { port: (server.address() as net.AddressInfo).port }));
    });
  });
}

describe('ping', () => {
  it('builds a single bounded echo request per platform', () => {
    expect(pingInvocation(V4, 'win32')).toEqual({ file: 'ping', args: ['-n', '1', '-w', '2000', V4.address] });
    expect(pingInvocation(V4, 'linux')).toEqual({ file: 'ping', args: ['-c', '1', '-W', '2', V4.address] });
    expect(pingInvocation(V4, 'darwin')).toEqual({ file: 'ping', args: ['-c', '1', '-t', '2', V4.address] });
    expect(pingInvocation(V6, 'darwin').file).toBe('ping6');
    expect(pingInvocation(V6, 'linux').file).toBe('ping');
  });

  it('reads the round trip from Linux, macOS and translated Windows output', () => {
    expect(
      readPingResult(
        { exitCode: 0, output: '64 bytes from 192.0.2.10: icmp_seq=1 ttl=57 time=12.3 ms' },
        V4,
        'linux',
      ),
    ).toEqual({ status: 'reply', rtt: '12.3 ms' });
    expect(
      readPingResult({ exitCode: 0, output: 'Antwort von 192.0.2.10: Bytes=32 Zeit<1ms TTL=128' }, V4, 'win32'),
    ).toEqual({ status: 'reply', rtt: '<1 ms' });
    expect(
      readPingResult({ exitCode: 0, output: '16 bytes from 2001:db8::10, icmp_seq=0 hlim=64 time=0.081 ms' }, V6, 'darwin'),
    ).toEqual({ status: 'reply', rtt: '0.081 ms' });
  });

  it('does not count a Windows "destination host unreachable" answer as a reply', () => {
    expect(
      readPingResult(
        { exitCode: 0, output: 'Reply from 192.0.2.1: Destination host unreachable.' },
        V4,
        'win32',
      ),
    ).toEqual({ status: 'no-reply' });
  });

  it('separates a ping that could not run from one that got no answer', () => {
    expect(readPingResult({ exitCode: 2, output: '' }, V4, 'darwin')).toEqual({ status: 'no-reply' });
    expect(
      readPingResult({ exitCode: 2, output: 'ping: socket: Operation not permitted\n' }, V4, 'linux'),
    ).toEqual({ status: 'unavailable', reason: 'ping: socket: Operation not permitted' });
  });
});

describe('SSH greeting', () => {
  it('skips lines a server may send before its identification', () => {
    const received = Buffer.from('Welcome to example\r\nSSH-2.0-OpenSSH_9.6p1 Ubuntu\r\n');
    expect(readGreeting(received)).toEqual({ kind: 'ssh', banner: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu' });
  });

  it('waits on a partial line until reading is over', () => {
    expect(readGreeting(Buffer.from('SSH-2.0-Op'))).toBeUndefined();
    expect(readGreeting(Buffer.from('HTTP/1.1 400 Bad Request\r\n'))).toBeUndefined();
    expect(readGreeting(Buffer.from('HTTP/1.1 400 Bad Request\r\n'), 'silent')).toEqual({
      kind: 'other',
      text: 'HTTP/1.1 400 Bad Request',
    });
    expect(readGreeting(Buffer.alloc(0), 'closed')).toEqual({ kind: 'closed' });
    expect(readGreeting(Buffer.alloc(0), 'silent')).toEqual({ kind: 'silent' });
  });

  it('keeps control bytes out of what it quotes', () => {
    const telnet = Buffer.from([0xff, 0xfd, 0x18, 0x6c, 0x6f, 0x67, 0x69, 0x6e, 0x3a]);
    expect(readGreeting(telnet, 'silent')).toEqual({ kind: 'other', text: 'login:' });
  });
});

describe('probeTcp', () => {
  const loopback: ResolvedAddress = { address: '127.0.0.1', family: 4 };
  const opts = { readGreeting: true, connectTimeoutMs: 2_000, greetingTimeoutMs: 200 };
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it('reads the greeting, an early close and silence', async () => {
    const ssh = await listen((socket) => socket.end('SSH-2.0-Test\r\n'));
    const closer = await listen((socket) => socket.destroy());
    const silent = await listen(() => {});
    servers.push(ssh, closer, silent);

    expect(await probeTcp(loopback, ssh.port, opts)).toMatchObject({
      outcome: 'connected',
      greeting: { kind: 'ssh', banner: 'SSH-2.0-Test' },
    });
    expect(await probeTcp(loopback, closer.port, opts)).toMatchObject({
      outcome: 'connected',
      greeting: { kind: 'closed' },
    });
    expect(await probeTcp(loopback, silent.port, opts)).toMatchObject({
      outcome: 'connected',
      greeting: { kind: 'silent' },
    });
  });

  it('reports a refused port', async () => {
    const server = await listen(() => {});
    const { port } = server;
    await new Promise((resolve) => server.close(resolve));
    expect(await probeTcp(loopback, port, opts)).toMatchObject({ outcome: 'refused' });
  });
});

describe('diagnoseEndpoint', () => {
  const ssh = { host: 'web.example.com', port: 22, service: 'ssh' as const };

  it('stops at a name that does not resolve', async () => {
    const connect = vi.fn();
    const result = await diagnoseEndpoint(
      ssh,
      fakeProbes({
        lookup: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        },
        connect,
      }),
    );
    expect(result.checks).toEqual([
      { label: 'DNS', status: 'fail', detail: 'web.example.com does not resolve' },
    ]);
    expect(result.conclusion).toMatch(/does not resolve from this computer/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('blames a firewall when the host pings but the port stays silent', async () => {
    const result = await diagnoseEndpoint(
      ssh,
      fakeProbes({ connect: async (address) => ({ address, outcome: 'timeout' }) }),
    );
    expect(result.checks.map((check) => [check.label, check.status])).toEqual([
      ['DNS', 'ok'],
      ['Ping', 'ok'],
      ['TCP', 'fail'],
    ]);
    expect(result.conclusion).toMatch(/answers ping, but port 22 does not answer/);
  });

  it('calls a host that answers nothing down or out of reach', async () => {
    const result = await diagnoseEndpoint(
      ssh,
      fakeProbes({
        ping: async () => ({ status: 'no-reply' }),
        connect: async (address) => ({ address, outcome: 'timeout' }),
      }),
    );
    expect(result.conclusion).toMatch(/does not answer from this computer/);
  });

  it('names a refused port', async () => {
    const result = await diagnoseEndpoint(
      ssh,
      fakeProbes({ connect: async (address) => ({ address, outcome: 'refused' }) }),
    );
    expect(result.conclusion).toMatch(/nothing accepts connections on port 22/);
  });

  it('does not let a missing IPv6 route hide a working IPv4 address', async () => {
    const result = await diagnoseEndpoint(
      ssh,
      fakeProbes({
        lookup: async () => [V6, V4],
        connect: async (address): Promise<TcpProbe> =>
          address.family === 6
            ? { address, outcome: 'unreachable', error: 'ENETUNREACH' }
            : { address, outcome: 'connected', ms: 3, greeting: { kind: 'ssh', banner: 'SSH-2.0-x' } },
      }),
    );
    expect(result.conclusion).toBeUndefined();
    expect(result.checks.filter((check) => check.label === 'TCP')).toEqual([
      { label: 'TCP', status: 'info', detail: '[2001:db8::10]:22: this computer has no route to IPv6 networks' },
      { label: 'TCP', status: 'ok', detail: '192.0.2.10:22 connected in 3 ms' },
    ]);
  });

  it('judges a timeout by the addresses that have a route', async () => {
    const result = await diagnoseEndpoint(
      ssh,
      fakeProbes({
        lookup: async () => [V6, V4],
        connect: async (address): Promise<TcpProbe> =>
          address.family === 6
            ? { address, outcome: 'unreachable', error: 'ENETUNREACH' }
            : { address, outcome: 'timeout' },
      }),
    );
    expect(result.conclusion).toMatch(/answers ping, but port 22 does not answer/);
  });

  it('skips DNS for an IP address and flags a port that does not speak SSH', async () => {
    const result = await diagnoseEndpoint(
      { host: '192.0.2.10', port: 80, service: 'ssh' },
      fakeProbes({
        lookup: async () => {
          throw new Error('not called');
        },
        connect: async (address) => ({
          address,
          outcome: 'connected',
          ms: 1,
          greeting: { kind: 'other', text: 'HTTP/1.1 400 Bad Request' },
        }),
      }),
    );
    expect(result.checks.map((check) => check.label)).toEqual(['Ping', 'TCP', 'SSH']);
    expect(result.conclusion).toBe('Port 80 answers, but not with SSH. Check the port number.');
  });
});

describe('diagnoseSsh', () => {
  it('checks a direct host down to its keys', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/run/agent.sock');
    // Outside the home directory, so it is quoted as written on every platform.
    const missing = '/nonexistent/muxus/id_missing';
    const chain = chainOf('web', [
      'Host web',
      '  HostName web.example.com',
      '  User deploy',
      `  IdentityFile ${missing}`,
    ]);
    const report = await diagnoseSsh(
      chain,
      fakeProbes({
        agent: async () => ({ available: true, keys: 0 }),
        readable: async (file) => (file === missing ? 'missing' : 'ok'),
      }),
    );
    expect(report.checked).toBe('web.example.com:22');
    expect(report.checks).toEqual([
      { label: 'Route', status: 'info', detail: 'web → deploy@web.example.com:22' },
      { label: 'DNS', status: 'ok', detail: expect.stringMatching(/^web\.example\.com → 192\.0\.2\.10 \(\d+ ms\)$/) },
      { label: 'Ping', status: 'ok', detail: '192.0.2.10 replied in 1.2 ms' },
      { label: 'TCP', status: 'ok', detail: '192.0.2.10:22 connected in 4 ms' },
      { label: 'SSH', status: 'ok', detail: 'SSH-2.0-OpenSSH_9.6' },
      { label: 'Agent', status: 'warn', detail: 'the agent is running but holds no keys' },
      { label: 'Key files', status: 'warn', detail: `${missing} not found` },
    ]);
    expect(report.conclusion).toMatch(/configured key files are missing/);
  });

  it('checks the first jump host, the only hop in reach', async () => {
    const chain = chainOf('app', [
      'Host app',
      '  HostName app.internal',
      '  ProxyJump bastion',
      '  IdentityAgent none',
      '',
      'Host bastion',
      '  HostName bastion.example.com',
      '  Port 2200',
    ]);
    const lookup = vi.fn(async () => [V4]);
    const report = await diagnoseSsh(chain, fakeProbes({ lookup }));
    expect(lookup).toHaveBeenCalledWith('bastion.example.com');
    expect(report.checked).toBe('bastion.example.com:2200');
    expect(report.checks[0]!.detail).toMatch(/^app → .*@app\.internal:22 via bastion$/);
    expect(report.checks.some((check) => check.label === 'Agent')).toBe(false);
    expect(report.conclusion).toMatch(/^bastion is reachable and speaks SSH\. app is dialed through it/);
  });

  it('does not dial around a ProxyCommand', async () => {
    const chain = chainOf('edge', [
      'Host edge',
      '  HostName edge.internal',
      '  ProxyCommand cloudflared access ssh --hostname %h',
      '  IdentityAgent none',
    ]);
    const connect = vi.fn();
    const report = await diagnoseSsh(chain, fakeProbes({ connect }));
    expect(connect).not.toHaveBeenCalled();
    expect(report.checks.map((check) => [check.label, check.status])).toEqual([
      ['Route', 'info'],
      ['Network', 'skipped'],
    ]);
    expect(report.conclusion).toContain('cloudflared access ssh --hostname edge.internal');
  });

  it('leaves key checks out for a password-only host', async () => {
    const chain = chainOf('legacy', ['Host legacy', '  HostName 192.0.2.10', '  PubkeyAuthentication no']);
    const report = await diagnoseSsh(chain, fakeProbes());
    expect(report.checks.map((check) => check.label)).toEqual(['Route', 'Ping', 'TCP', 'SSH']);
    expect(report.conclusion).toMatch(/failed after the greeting/);
  });
});

describe('diagnoseTelnet', () => {
  it('reads no greeting and calls an open port fine', async () => {
    const connect = vi.fn(async (address: ResolvedAddress, _port: number, readGreeting: boolean) => {
      expect(readGreeting).toBe(false);
      return { address, outcome: 'connected' as const, ms: 2 };
    });
    const report = await diagnoseTelnet({ host: 'switch.example.com', port: 23 }, fakeProbes({ connect }));
    expect(report.checked).toBe('switch.example.com:23');
    expect(report.conclusion).toMatch(/accepts connections, so the network path is fine/);
  });
});
