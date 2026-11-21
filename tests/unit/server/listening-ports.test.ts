import { describe, expect, it } from 'vitest';
import {
  listeningPorts,
  mergeListeners,
  parseLsof,
  parseNetstat,
  parseSs,
} from '../../../server/src/environments/ports.js';
import type { ProbeResult, ProbeRunner } from '../../../server/src/environments/probe-runner.js';

const SS = `State  Recv-Q Send-Q   Local Address:Port    Peer Address:Port Process
LISTEN 0      4096     127.0.0.53%lo:53           0.0.0.0:*     users:(("systemd-resolve",pid=812,fd=15))
LISTEN 0      128            0.0.0.0:22           0.0.0.0:*     users:(("sshd",pid=1001,fd=3))
LISTEN 0      511                  *:80                 *:*     users:(("nginx",pid=1420,fd=6),("nginx",pid=1421,fd=6))
LISTEN 0      128               [::]:22              [::]:*     users:(("sshd",pid=1001,fd=4))
LISTEN 0      4096             [::1]:6379            [::]:*
LISTEN 0      4096   [::ffff:127.0.0.1]:9200            *:*     users:(("java",pid=2200,fd=311))
LISTEN 0      10     [fe80::1]%eth0:5355            [::]:*     users:(("my \\"odd\\" app",pid=7,fd=1))
`;

describe('reading ss', () => {
  it('reads addresses of every shape, skipping the header', () => {
    expect(parseSs(SS)).toEqual([
      { address: '127.0.0.53', port: 53, process: 'systemd-resolve', pid: 812 },
      { address: '0.0.0.0', port: 22, process: 'sshd', pid: 1001 },
      { address: '*', port: 80, process: 'nginx', pid: 1420 },
      { address: '::', port: 22, process: 'sshd', pid: 1001 },
      { address: '::1', port: 6379 },
      { address: '127.0.0.1', port: 9200, process: 'java', pid: 2200 },
      { address: 'fe80::1', port: 5355, process: 'my "odd" app', pid: 7 },
    ]);
  });

  it('reads the list without a header, as ss -H prints it', () => {
    expect(parseSs('LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n')).toEqual([{ address: '0.0.0.0', port: 22 }]);
  });

  it('ignores what is not a listening socket', () => {
    expect(parseSs('ESTAB 0 0 10.0.0.4:22 10.0.0.9:51234\nNetid State\n\n')).toEqual([]);
  });
});

describe('reading netstat', () => {
  it('reads net-tools and BusyBox output, with programs where they are named', () => {
    const output = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1001/sshd
tcp        0      0 127.0.0.1:5432          0.0.0.0:*               LISTEN      -
tcp6       0      0 :::8080                 :::*                    LISTEN      2311/docker-proxy
tcp6       0      0 ::1:631                 :::*                    LISTEN      900/cupsd
udp        0      0 0.0.0.0:68              0.0.0.0:*                           -
`;
    expect(parseNetstat(output)).toEqual([
      { address: '0.0.0.0', port: 22, process: 'sshd', pid: 1001 },
      { address: '127.0.0.1', port: 5432 },
      { address: '::', port: 8080, process: 'docker-proxy', pid: 2311 },
      { address: '::1', port: 631, process: 'cupsd', pid: 900 },
    ]);
  });

  it('reads the BSD and macOS form, where a dot precedes the port', () => {
    const output = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  *.22                   *.*                    LISTEN
tcp4       0      0  127.0.0.1.631          *.*                    LISTEN
tcp6       0      0  ::1.631                *.*                    LISTEN
tcp6       0      0  fe80::1%lo0.8021       *.*                    LISTEN
tcp4       0      0  10.0.0.4.22            10.0.0.9.51234         ESTABLISHED
`;
    expect(parseNetstat(output)).toEqual([
      { address: '*', port: 22 },
      { address: '127.0.0.1', port: 631 },
      { address: '::1', port: 631 },
      { address: 'fe80::1', port: 8021 },
    ]);
  });

  it('reads the Windows form', () => {
    const output = `
Active Connections

  Proto  Local Address          Foreign Address        State
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING
  TCP    [::]:445               [::]:0                 LISTENING
  TCP    192.168.1.20:49712     52.1.2.3:443           ESTABLISHED
`;
    expect(parseNetstat(output)).toEqual([
      { address: '0.0.0.0', port: 135 },
      { address: '::', port: 445 },
    ]);
  });
});

describe('reading lsof', () => {
  it('reads listening sockets with their programs', () => {
    const output = `COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
rapportd    612 alice    8u  IPv4 0x8a1b2c3d4e5f6071      0t0  TCP *:49152 (LISTEN)
rapportd    612 alice    9u  IPv6 0x8a1b2c3d4e5f6072      0t0  TCP *:49152 (LISTEN)
Code\\x20Hel 990 alice   21u  IPv4 0x8a1b2c3d4e5f6073      0t0  TCP 127.0.0.1:3000 (LISTEN)
postgres   1200 alice    7u  IPv6 0x8a1b2c3d4e5f6074      0t0  TCP [::1]:5432 (LISTEN)
ssh        1300 alice    5u  IPv4 0x8a1b2c3d4e5f6075      0t0  TCP 10.0.0.4:51000->10.0.0.9:22 (ESTABLISHED)
`;
    expect(parseLsof(output)).toEqual([
      { address: '*', port: 49152, process: 'rapportd', pid: 612 },
      { address: '*', port: 49152, process: 'rapportd', pid: 612 },
      { address: '127.0.0.1', port: 3000, process: 'Code Hel', pid: 990 },
      { address: '::1', port: 5432, process: 'postgres', pid: 1200 },
    ]);
  });
});

describe('merging sockets into services', () => {
  it('makes one entry of a service on IPv4 and IPv6, ordered by port', () => {
    expect(mergeListeners(parseSs(SS))).toEqual([
      { port: 22, addresses: ['0.0.0.0', '::'], process: 'sshd', pid: 1001 },
      { port: 53, addresses: ['127.0.0.53'], process: 'systemd-resolve', pid: 812 },
      { port: 80, addresses: ['*'], process: 'nginx', pid: 1420 },
      { port: 5355, addresses: ['fe80::1'], process: 'my "odd" app', pid: 7 },
      { port: 6379, addresses: ['::1'] },
      { port: 9200, addresses: ['127.0.0.1'], process: 'java', pid: 2200 },
    ]);
  });

  it('folds a socket whose program is hidden into the named one on that port', () => {
    expect(
      mergeListeners([
        { address: '0.0.0.0', port: 443, process: 'nginx', pid: 9 },
        { address: '::', port: 443 },
      ]),
    ).toEqual([{ port: 443, addresses: ['0.0.0.0', '::'], process: 'nginx', pid: 9 }]);
  });

  it('keeps two programs sharing a port apart', () => {
    expect(
      mergeListeners([
        { address: '10.0.0.1', port: 53, process: 'dnsmasq', pid: 1 },
        { address: '127.0.0.53', port: 53, process: 'systemd-resolve', pid: 2 },
      ]),
    ).toHaveLength(2);
  });
});

const ran = (stdout: string, exitCode = 0, stderr = ''): ProbeResult => ({ status: 'ran', exitCode, stdout, stderr });
const MISSING: ProbeResult = { status: 'missing' };

/** A host that answers each probe id with a fixed result and records what it was asked. */
function hostWith(results: Record<string, ProbeResult>) {
  const batches: string[][] = [];
  const run: ProbeRunner = async (probes) => {
    batches.push(probes.map((probe) => probe.id));
    return new Map(probes.map((probe) => [probe.id, results[probe.id] ?? MISSING]));
  };
  return { run, batches };
}

describe('listing a host’s ports', () => {
  it('asks ss alone on a host that has it', async () => {
    const { run, batches } = hostWith({ ss: ran(SS) });
    const response = await listeningPorts(run);
    expect(response).toMatchObject({ status: 'ok', tool: 'ss' });
    expect(response.status === 'ok' && response.ports.map((port) => port.port)).toEqual([22, 53, 80, 5355, 6379, 9200]);
    expect(batches).toEqual([['ss']]);
  });

  it('falls back to netstat with program names', async () => {
    const { run, batches } = hostWith({
      'netstat-programs': ran('tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 1001/sshd\n'),
    });
    await expect(listeningPorts(run)).resolves.toEqual({
      status: 'ok',
      tool: 'netstat',
      ports: [{ port: 22, addresses: ['0.0.0.0'], process: 'sshd', pid: 1001 }],
    });
    expect(batches).toHaveLength(2);
  });

  it('uses lsof where netstat names no programs, as on macOS', async () => {
    const { run } = hostWith({
      'netstat-programs': ran('', 1, 'netstat: option requires an argument -- p'),
      lsof: ran('sshd 99 root 3u IPv4 0x1 0t0 TCP *:22 (LISTEN)\n'),
      'netstat-all': ran('tcp4 0 0 *.22 *.* LISTEN\n'),
    });
    await expect(listeningPorts(run)).resolves.toEqual({
      status: 'ok',
      tool: 'lsof',
      ports: [{ port: 22, addresses: ['*'], process: 'sshd', pid: 99 }],
    });
  });

  it('reads lsof as an empty list when nothing listens: it exits 1 then', async () => {
    const { run } = hostWith({ lsof: ran('', 1) });
    await expect(listeningPorts(run)).resolves.toEqual({ status: 'ok', tool: 'lsof', ports: [] });
  });

  it('settles for netstat without programs', async () => {
    const { run } = hostWith({
      'netstat-programs': ran('', 1, 'netstat: invalid option -- p'),
      netstat: ran('tcp 0 0 :::8080 :::* LISTEN\n'),
    });
    await expect(listeningPorts(run)).resolves.toEqual({
      status: 'ok',
      tool: 'netstat',
      ports: [{ port: 8080, addresses: ['::'] }],
    });
  });

  it('says so when the host has none of the tools', async () => {
    const { run } = hostWith({});
    await expect(listeningPorts(run)).resolves.toEqual({
      status: 'unavailable',
      message: 'The host has no ss, netstat or lsof to list ports with.',
    });
  });

  it('passes on why the only tool there failed', async () => {
    const { run } = hostWith({ ss: ran('', 255, 'Cannot open netlink socket: Permission denied') });
    await expect(listeningPorts(run)).resolves.toEqual({
      status: 'unavailable',
      message: 'Could not list ports: Cannot open netlink socket: Permission denied',
    });
  });
});
