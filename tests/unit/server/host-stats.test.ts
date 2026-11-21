import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { registerHostStatsRoutes } from '../../../server/src/routes/host-stats.js';
import { SshError } from '../../../server/src/ssh/engine.js';
import {
  HOST_STATS_SCRIPT,
  hostStatsScript,
  parseHostStats,
  readLocalHostStats,
  readRemoteHostStats,
} from '../../../server/src/stats/host-stats.js';
import { hostStatsReaderFor } from '../../../server/src/stats/host-stats-reader.js';

const section = (name: string, ...lines: string[]) => [`@@muxus:${name}`, ...lines].join('\n');

const LINUX_OUTPUT = [
  'Welcome to web-01! Unauthorized access is prohibited.',
  '',
  section('begin'),
  section('hostname', 'web-01'),
  section('kernel', 'Linux 6.8.0-45-generic'),
  section('os-release', 'NAME="Ubuntu"', 'VERSION_ID="24.04"', 'PRETTY_NAME="Ubuntu 24.04.1 LTS"'),
  section(
    'who',
    'alice    pts/0        2026-10-08 10:00 (10.0.0.5)',
    'bob      pts/1        2026-10-08 10:02 (10.0.0.6)',
    'alice    pts/2        2026-10-08 11:30 (10.0.0.5)',
  ),
  section(
    'df',
    'Filesystem     1024-blocks     Used Available Capacity Mounted on',
    '/dev/sda1         41152736 18000000  21036000      47% /',
  ),
  section('uptime', '1054312.47 4011231.20'),
  section('stat', 'cpu  10132153 290696 3084719 46828483 16683 0 25195 0 175628 0', '4'),
  section('loadavg', '0.12 0.30 0.25 1/234 5678'),
  section(
    'meminfo',
    'MemTotal:        4028228 kB',
    'MemFree:          312040 kB',
    'MemAvailable:    2654120 kB',
    'Buffers:          120004 kB',
    'Cached:          2014200 kB',
    'SwapTotal:       2097148 kB',
    'SwapFree:        2000000 kB',
  ),
  section(
    'route',
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
  ),
  section(
    'netdev',
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo:    1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0',
    'docker0: 999999999 10 0 0 0 0 0 0 5 1 0 0 0 0 0 0',
    '  eth0: 123456789  1000    0    0    0     0          0         0 98765432     900    0    0    0     0       0          0',
  ),
  section('end'),
].join('\n');

const MAC_OUTPUT = [
  section('begin'),
  section('hostname', 'studio.local'),
  section('kernel', 'Darwin 23.5.0'),
  section('os-release'),
  section('who', 'alice    console  Oct  8 09:00 ', 'alice    ttys000  Oct  8 10:00 '),
  section(
    'df',
    'Filesystem     1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1   971350180  10340000 600000000     2%    /',
  ),
  section('sw-vers', 'ProductName:\t\tmacOS', 'ProductVersion:\t\t14.5', 'BuildVersion:\t\t23F79'),
  section('now', '1728400000'),
  section('boottime', '{ sec = 1728370000, usec = 123456 } Tue Oct  8 08:46:40 2024'),
  section('bsd-loadavg', '{ 1.52 1.71 1.80 }'),
  section('ncpu', '10'),
  section('memsize', '17179869184'),
  section(
    'vm-stat',
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               12345.',
    'Pages active:                            300000.',
    'Pages inactive:                          290000.',
    'Pages speculative:                         5000.',
    'Pages wired down:                        150000.',
  ),
  section(
    'bsd-route',
    '   route to: default',
    'destination: default',
    '    gateway: 192.168.1.1',
    '  interface: en0',
  ),
  section(
    'netstat',
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    'lo0        16384 <Link#1>                         123456     0   98765432   123456     0   98765432     0',
    'lo0        16384 127           127.0.0.1          123456     -   98765432   123456     -   98765432     -',
    'en0        1500  <Link#6>    a4:83:e7:12:34:56  5000000     0 6000000000  3000000     0  400000000     0',
    'en0        1500  192.168.1     192.168.1.20       5000000     -  6000000000  3000000     -   400000000     -',
  ),
  section('end'),
].join('\n');

describe('reading host statistics', () => {
  it('reads every Linux source, ignoring a banner before the first marker', () => {
    expect(parseHostStats(LINUX_OUTPUT)).toEqual({
      hostname: 'web-01',
      kernel: 'Linux 6.8.0-45-generic',
      os: 'Ubuntu 24.04.1 LTS',
      uptimeSeconds: 1054312.47,
      cpuTime: {
        total: 10132153 + 290696 + 3084719 + 46828483 + 16683 + 0 + 25195 + 0,
        idle: 46828483 + 16683,
      },
      cores: 4,
      loadAverage: [0.12, 0.3, 0.25],
      memory: {
        totalBytes: 4028228 * 1024,
        availableBytes: 2654120 * 1024,
        swapTotalBytes: 2097148 * 1024,
        swapFreeBytes: 2000000 * 1024,
      },
      network: { interface: 'eth0', receivedBytes: 123456789, sentBytes: 98765432 },
      users: ['alice', 'bob', 'alice'],
      disk: {
        mount: '/',
        totalBytes: 41152736 * 1024,
        usedBytes: 18000000 * 1024,
        availableBytes: 21036000 * 1024,
      },
    });
  });

  it('estimates available memory on old kernels and picks the busiest link without a default route', () => {
    const output = [
      section('begin'),
      section('meminfo', 'MemTotal: 1000 kB', 'MemFree: 100 kB', 'Buffers: 50 kB', 'Cached: 250 kB'),
      section('route', 'Iface\tDestination\tGateway'),
      section(
        'netdev',
        'Inter-|   Receive',
        '    lo: 5000000 1 0 0 0 0 0 0 5000000 1 0 0 0 0 0 0',
        '  ens3: 300 1 0 0 0 0 0 0 30 1 0 0 0 0 0 0',
        '  ens4: 900 1 0 0 0 0 0 0 90 1 0 0 0 0 0 0',
      ),
    ].join('\n');
    expect(parseHostStats(output)).toMatchObject({
      memory: { totalBytes: 1000 * 1024, availableBytes: 400 * 1024 },
      network: { interface: 'ens4', receivedBytes: 900, sentBytes: 90 },
    });
  });

  it('reads macOS through sw_vers, sysctl, vm_stat, route and netstat', () => {
    const sample = parseHostStats(MAC_OUTPUT);
    expect(sample).toEqual({
      hostname: 'studio.local',
      kernel: 'Darwin 23.5.0',
      os: 'macOS 14.5',
      uptimeSeconds: 30000,
      cores: 10,
      loadAverage: [1.52, 1.71, 1.8],
      memory: {
        totalBytes: 17179869184,
        availableBytes: (12345 + 290000 + 5000) * 16384,
      },
      network: { interface: 'en0', receivedBytes: 6000000000, sentBytes: 400000000 },
      users: ['alice', 'alice'],
      disk: {
        mount: '/',
        totalBytes: 971350180 * 1024,
        usedBytes: 10340000 * 1024,
        availableBytes: 600000000 * 1024,
      },
    });
    expect(sample?.cpuTime).toBeUndefined();
  });

  it('falls back to the kernel for the system name and reports nobody logged in', () => {
    const output = [
      section('begin'),
      section('kernel', 'FreeBSD 14.0-RELEASE'),
      section('who'),
    ].join('\n');
    expect(parseHostStats(output)).toEqual({
      kernel: 'FreeBSD 14.0-RELEASE',
      os: 'FreeBSD 14.0-RELEASE',
      users: [],
    });
  });

  it('recognizes a host that never ran the script', () => {
    expect(parseHostStats('')).toBeUndefined();
    expect(parseHostStats('% Invalid input detected at \'^\' marker.\r\n')).toBeUndefined();
    expect(parseHostStats("'sh' is not recognized as an internal or external command")).toBeUndefined();
  });
});

class StubChannel extends EventEmitter {
  readonly stderr = new PassThrough();
  written = '';
  constructor(private readonly reply: string) {
    super();
  }
  end(script: string): this {
    this.written = script;
    setImmediate(() => {
      this.emit('data', Buffer.from(this.reply));
      this.emit('close');
    });
    return this;
  }
  destroy(): this {
    return this;
  }
}

function stubTransport(reply: string | Error) {
  const channel = typeof reply === 'string' ? new StubChannel(reply) : undefined;
  const exec = vi.fn(async (_command: string) => {
    if (reply instanceof Error) throw reply;
    return channel;
  });
  return { transport: { exec } as never, exec, channel };
}

describe('reading a remote host', () => {
  it('runs the script through sh on stdin, so the login shell never parses it', async () => {
    const { transport, exec, channel } = stubTransport(LINUX_OUTPUT);
    const reading = await readRemoteHostStats(transport);
    expect(exec).toHaveBeenCalledWith('sh -s');
    expect(channel?.written).toBe(HOST_STATS_SCRIPT);
    expect(reading).toMatchObject({ supported: true, sample: { hostname: 'web-01' } });
  });

  it('reports a host that answers without the markers as unsupported', async () => {
    const { transport } = stubTransport('Command not allowed\r\n');
    await expect(readRemoteHostStats(transport)).resolves.toEqual({ supported: false });
  });

  it('rejects when the server refuses the channel', async () => {
    const { transport } = stubTransport(
      new SshError('Channel open failure: administratively prohibited', 'CHANNEL_OPEN_FAILED', 1),
    );
    await expect(readRemoteHostStats(transport)).rejects.toThrow('Channel open failure');
  });
});

describe.skipIf(process.platform !== 'linux')('reading this Linux machine', () => {
  it('runs the real script and gets every source', async () => {
    const sample = await readLocalHostStats();
    expect(sample.hostname).toBeTruthy();
    expect(sample.kernel).toMatch(/^Linux /);
    expect(sample.os).toBeTruthy();
    expect(sample.uptimeSeconds).toBeGreaterThan(0);
    expect(sample.cpuTime?.total).toBeGreaterThan(0);
    expect(sample.cores).toBeGreaterThan(0);
    expect(sample.loadAverage).toHaveLength(3);
    expect(sample.memory?.totalBytes).toBeGreaterThan(0);
    expect(sample.disk?.mount).toBe('/');
    expect(sample.disk?.totalBytes).toBeGreaterThan(0);
  });
});

describe('readings for the host monitor', () => {
  const withSections = (...extra: string[]) => [section('begin'), section('hostname', 'gpu-01'), ...extra, section('end')].join('\n');

  it('asks for disk counters and GPUs only when told to', () => {
    expect(HOST_STATS_SCRIPT).not.toContain('diskstats');
    expect(HOST_STATS_SCRIPT).not.toContain('nvidia-smi');
    expect(hostStatsScript({ diskIo: true })).toContain('cat /proc/diskstats');
    expect(hostStatsScript({ diskIo: true })).not.toContain('nvidia-smi');
    expect(hostStatsScript({ gpu: true })).toContain('command -v nvidia-smi');
    // Whatever is added, the end marker stays last.
    expect(hostStatsScript({ diskIo: true, gpu: true }).trimEnd().endsWith('muxus_section end')).toBe(true);
  });

  it('sums whole disks only: no partitions, device-mapper, RAID or loop devices', () => {
    const sample = parseHostStats(
      withSections(
        section('blockdevs', 'dm-0', 'loop0', 'md0', 'nvme0n1', 'sda', 'sr0'),
        section(
          'diskstats',
          '   7       0 loop0 100 0 2000 10 0 0 0 0 0 10 10',
          '   8       0 sda 5000 10 100000 900 3000 20 60000 700 0 1500 1600',
          '   8       1 sda1 4000 10 80000 800 2500 20 50000 600 0 1300 1400',
          '   8       2 sda2 1000 0 20000 100 500 0 10000 100 0 200 200',
          ' 259       0 nvme0n1 9000 0 400000 300 7000 0 200000 200 0 400 500',
          ' 259       1 nvme0n1p1 9000 0 400000 300 7000 0 200000 200 0 400 500',
          ' 253       0 dm-0 9000 0 400000 300 7000 0 200000 200 0 400 500',
          '   9       0 md0 9000 0 400000 300 7000 0 200000 200 0 400 500',
          '  11       0 sr0 5 0 40 1 0 0 0 0 0 1 1',
        ),
      ),
    );
    // sda + nvme0n1, in 512-byte sectors.
    expect(sample?.diskIo).toEqual({ readBytes: (100000 + 400000) * 512, writtenBytes: (60000 + 200000) * 512 });
  });

  it('tells partitions by their names when /sys/block cannot be listed', () => {
    const sample = parseHostStats(
      withSections(
        section(
          'diskstats',
          ' 252       0 vda 10 0 1000 0 10 0 2000 0 0 0 0',
          ' 252       1 vda1 10 0 1000 0 10 0 2000 0 0 0 0',
          ' 179       0 mmcblk0 10 0 300 0 10 0 400 0 0 0 0',
          ' 179       1 mmcblk0p1 10 0 300 0 10 0 400 0 0 0 0',
          ' 202       0 xvda 10 0 50 0 10 0 60 0 0 0 0',
          ' 202       1 xvda1 10 0 50 0 10 0 60 0 0 0 0',
        ),
      ),
    );
    expect(sample?.diskIo).toEqual({ readBytes: 1350 * 512, writtenBytes: 2460 * 512 });
  });

  it('leaves disk counters out on a host without them', () => {
    expect(parseHostStats(withSections())?.diskIo).toBeUndefined();
    expect(parseHostStats(withSections(section('diskstats')))?.diskIo).toBeUndefined();
  });

  it('reads NVIDIA cards, including what the driver cannot tell', () => {
    const sample = parseHostStats(
      withSections(
        section(
          'gpu',
          '0, NVIDIA GeForce RTX 4090, 37, 8123, 24564, 61',
          '1, Tesla T4, [N/A], 15, 15360, [N/A]',
          'NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.',
        ),
      ),
    );
    expect(sample?.gpus).toEqual([
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 4090',
        utilization: 0.37,
        memoryUsedBytes: 8123 * 1024 * 1024,
        memoryTotalBytes: 24564 * 1024 * 1024,
        temperatureCelsius: 61,
      },
      { index: 1, name: 'Tesla T4', memoryUsedBytes: 15 * 1024 * 1024, memoryTotalBytes: 15360 * 1024 * 1024 },
    ]);
  });

  it('times how long the host takes to start answering', async () => {
    const { transport, channel } = stubTransport(LINUX_OUTPUT);
    const reading = await readRemoteHostStats(transport, hostStatsScript({ diskIo: true }));
    expect(channel?.written).toBe(hostStatsScript({ diskIo: true }));
    expect(reading.supported).toBe(true);
    if (!reading.supported) return;
    expect(reading.latencyMs).toBeTypeOf('number');
    expect(reading.latencyMs).toBeGreaterThanOrEqual(0);
    expect(reading.latencyMs).toBeLessThan(1000);
  });
});

type RouteHandler = (request: unknown, reply: unknown) => Promise<unknown>;

/** A live connection as the reader sees it: a transport, and what is known about the host. */
function fakeConnection(transport: unknown, facts: { ranCommand?: boolean; commandsDeclined?: boolean } = {}) {
  return {
    id: 'conn-1',
    transport,
    profile: { kind: 'ssh', target: 'web-01' },
    user: 'deploy',
    host: 'web-01.example.net',
    port: 22,
    ranCommand: () => facts.ranCommand ?? true,
    commandsDeclined: () => facts.commandsDeclined ?? false,
    onClose: () => () => undefined,
  };
}

function captureRoutes(acquire: (connId: string, owner: string) => unknown) {
  const gets = new Map<string, RouteHandler>();
  const app = { get: (path: string, handler: RouteHandler) => gets.set(path, handler) };
  const hostStats = hostStatsReaderFor({
    systemOpenSsh: { acquire: () => undefined },
    connections: { acquire: acquire as never },
  });
  registerHostStatsRoutes(app as never, { hostStats });
  return gets;
}

function fakeReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    code(status: number) {
      reply.statusCode = status;
      return { send: async (body: unknown) => void (reply.body = body) };
    },
  };
  return reply;
}

describe('host statistics route', () => {
  it('reads a live connection under its own lease and releases it', async () => {
    const release = vi.fn();
    const { transport, exec } = stubTransport(LINUX_OUTPUT);
    const acquire = vi.fn(() => ({ connection: fakeConnection(transport), owner: 'stats', release }));
    const handler = captureRoutes(acquire).get('/api/host-stats/ssh/:connId')!;

    const response = await handler({ params: { connId: 'conn-1' } }, fakeReply());

    expect(acquire).toHaveBeenCalledWith('conn-1', 'stats');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ status: 'ok', sample: { hostname: 'web-01' } });
    expect((response as { sampledAt: number }).sampledAt).toBeTypeOf('number');
  });

  it('shares one reading between requests for the same connection', async () => {
    const { transport, exec } = stubTransport(LINUX_OUTPUT);
    const handler = captureRoutes(() => ({ connection: fakeConnection(transport), release: vi.fn() })).get(
      '/api/host-stats/ssh/:connId',
    )!;
    const [first, second] = await Promise.all([
      handler({ params: { connId: 'conn-1' } }, fakeReply()),
      handler({ params: { connId: 'conn-1' } }, fakeReply()),
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ status: 'ok', sample: (first as { sample: unknown }).sample });
  });

  it('answers unsupported for a host without a POSIX shell', async () => {
    const { transport } = stubTransport('Invalid command\r\n');
    const handler = captureRoutes(() => ({ connection: fakeConnection(transport), release: vi.fn() })).get(
      '/api/host-stats/ssh/:connId',
    )!;
    await expect(handler({ params: { connId: 'conn-1' } }, fakeReply())).resolves.toMatchObject({
      status: 'unsupported',
    });
  });

  it('never opens a channel on a connection whose server has not run a command', async () => {
    // Old SR OS releases drop the whole transport when a second channel asks to exec.
    const release = vi.fn();
    const { transport, exec } = stubTransport(LINUX_OUTPUT);
    const handler = captureRoutes(() => ({
      connection: fakeConnection(transport, { ranCommand: false }),
      release,
    })).get('/api/host-stats/ssh/:connId')!;
    await expect(handler({ params: { connId: 'conn-1' } }, fakeReply())).resolves.toMatchObject({
      status: 'unsupported',
    });
    expect(exec).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a connection that is gone', async () => {
    const handler = captureRoutes(() => undefined).get('/api/host-stats/ssh/:connId')!;
    const reply = fakeReply();
    await handler({ params: { connId: 'gone' } }, reply);
    expect(reply.statusCode).toBe(404);
    expect(reply.body).toEqual({ message: 'connection not found' });
  });
});
