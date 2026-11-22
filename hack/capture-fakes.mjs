// Invented readings for the screenshots. The demo hosts are this computer
// underneath, so the status bar, the host monitor, container discovery and the
// listening ports would otherwise show the hostname, OS, memory, containers
// and open ports of whoever runs the capture. Each page answers those with the
// values below instead; everything else still reaches the sandbox.

const GiB = 1024 ** 3;

/** What each host claims to be. Rates are per second; counters grow with the clock. */
const MACHINES = {
  local: { os: 'Ubuntu 24.04.1 LTS', kernel: 'Linux 6.8.0-49-generic', cores: 12, cpu: 0.09, load: [0.62, 0.71, 0.66], mem: [32, 19.4], disk: [512, 231], rx: 48_000, tx: 12_000, users: ['ops'], days: 3.2 },
  'web-01': { os: 'Debian GNU/Linux 12 (bookworm)', kernel: 'Linux 6.1.0-27-amd64', cores: 4, cpu: 0.21, load: [0.31, 0.28, 0.22], mem: [8, 4.9], disk: [80, 37], rx: 1_840_000, tx: 2_610_000, users: ['deploy'], days: 12.4 },
  'web-02': { os: 'Debian GNU/Linux 12 (bookworm)', kernel: 'Linux 6.1.0-27-amd64', cores: 4, cpu: 0.17, load: [0.24, 0.26, 0.2], mem: [8, 5.3], disk: [80, 35], rx: 1_520_000, tx: 2_190_000, users: ['deploy'], days: 12.4 },
  'cache-01': { os: 'Ubuntu 22.04.5 LTS', kernel: 'Linux 5.15.0-125-generic', cores: 2, cpu: 0.06, load: [0.08, 0.05, 0.04], mem: [4, 1.1], disk: [40, 11], rx: 420_000, tx: 610_000, users: ['deploy'], days: 41.7 },
  bastion: { os: 'Alpine Linux v3.20', kernel: 'Linux 6.6.58-0-virt', cores: 1, cpu: 0.02, load: [0.01, 0.02, 0.0], mem: [1, 0.72], disk: [10, 2.1], rx: 9_000, tx: 7_000, users: ['jump', 'jump'], days: 88.1 },
  'db-01': { os: 'Rocky Linux 9.4 (Blue Onyx)', kernel: 'Linux 5.14.0-427.42.1.el9_4.x86_64', cores: 8, cpu: 0.34, load: [2.1, 1.88, 1.7], mem: [64, 21.6], disk: [1024, 702], rx: 3_100_000, tx: 1_200_000, users: ['postgres'], days: 27.9 },
  'build-01': { os: 'Ubuntu 24.04.1 LTS', kernel: 'Linux 6.8.0-49-generic', cores: 16, cpu: 0.58, load: [7.9, 6.4, 5.1], mem: [64, 30.2], disk: [960, 512], rx: 6_400_000, tx: 880_000, users: ['ci'], days: 5.6 },
};

function sampleFor(name) {
  const m = MACHINES[name] ?? MACHINES['web-02'];
  const t = Date.now() / 1000;
  // Counters only ever grow; a slow wobble in the idle time makes successive
  // CPU shares differ the way real ones do, within ±15% of the base share.
  const ticks = t * 100 * m.cores;
  const wobble = 0.15 * m.cpu * 100 * m.cores * 7 * Math.sin(t / 7 + name.length);
  return {
    hostname: name === 'local' ? 'workstation' : name,
    os: m.os,
    kernel: m.kernel,
    uptimeSeconds: Math.round(m.days * 86_400 + (t % 86_400)),
    cpuTime: { total: ticks, idle: ticks * (1 - m.cpu) - wobble },
    cores: m.cores,
    loadAverage: m.load,
    memory: {
      totalBytes: m.mem[0] * GiB,
      availableBytes: (m.mem[0] - m.mem[1]) * GiB,
      swapTotalBytes: 2 * GiB,
      swapFreeBytes: 1.8 * GiB,
    },
    network: { interface: 'eth0', receivedBytes: Math.round(t * m.rx), sentBytes: Math.round(t * m.tx) },
    users: m.users,
    disk: { mount: '/', totalBytes: m.disk[0] * GiB, usedBytes: m.disk[1] * GiB, availableBytes: (m.disk[0] - m.disk[1]) * GiB },
    diskIo: { readBytes: Math.round(t * m.rx * 0.6), writtenBytes: Math.round(t * m.tx * 0.9) },
  };
}

/** The compose project the demo web servers run (see docker-compose.yml in demo-env). */
const WEB_CONTAINERS = (host) => ({
  status: 'ok',
  sampledAt: Date.now(),
  problems: [],
  environments: [
    {
      kind: 'containers',
      runtime: 'docker',
      version: '27.3.1',
      containers: [
        { id: `${host}a1`, name: 'edge', image: 'registry.internal/edge:2.14.1', state: 'running', status: 'Up 12 days', composeProject: 'edge', ports: [{ hostIp: '127.0.0.1', hostPort: 8080, containerPort: 8080, protocol: 'tcp' }] },
        { id: `${host}b2`, name: 'nginx', image: 'nginx:1.27-alpine', state: 'running', status: 'Up 12 days', composeProject: 'edge', ports: [{ hostIp: '0.0.0.0', hostPort: 443, containerPort: 443, protocol: 'tcp' }, { hostIp: '0.0.0.0', hostPort: 80, containerPort: 80, protocol: 'tcp' }] },
        { id: `${host}c3`, name: 'node-exporter', image: 'prom/node-exporter:v1.8.2', state: 'running', status: 'Up 12 days', composeProject: 'edge', ports: [{ hostIp: '0.0.0.0', hostPort: 9100, containerPort: 9100, protocol: 'tcp' }] },
      ],
    },
  ],
});

const NO_ENVIRONMENTS = () => ({ status: 'ok', sampledAt: Date.now(), problems: [], environments: [] });

const PORTS = {
  'web-01': [
    { port: 22, addresses: ['0.0.0.0', '::'], process: 'sshd' },
    { port: 80, addresses: ['0.0.0.0'], process: 'docker-proxy' },
    { port: 443, addresses: ['0.0.0.0'], process: 'docker-proxy' },
    { port: 8080, addresses: ['127.0.0.1'], process: 'docker-proxy' },
    { port: 9100, addresses: ['0.0.0.0'], process: 'docker-proxy' },
  ],
  local: [
    { port: 631, addresses: ['127.0.0.1', '::1'], process: 'cupsd' },
    { port: 5432, addresses: ['127.0.0.1'], process: 'postgres' },
  ],
};

/**
 * Answers the readings for one page. `api` is the capture's authorized fetch
 * against the sandbox, used to learn which host a connection id belongs to.
 */
export async function installCaptureFakes(page, api) {
  const targetOf = async (connId) => {
    const { connections } = await api('/api/connections');
    return connections.find((connection) => connection.id === connId)?.target ?? 'web-02';
  };

  await page.route(/\/api\/host-stats\/(local|ssh\/[^/?]+)(\?|$)/, async (route) => {
    const match = /\/api\/host-stats\/(?:local|ssh\/([^/?]+))/.exec(route.request().url());
    const name = match[1] ? await targetOf(decodeURIComponent(match[1])) : 'local';
    await route.fulfill({ json: { status: 'ok', sampledAt: Date.now(), sample: sampleFor(name) } });
  });

  await page.route(/\/api\/environments\/(local|ssh\/[^/?]+)(\/ports)?(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const match = /\/api\/environments\/(?:local|ssh\/([^/?]+))(\/ports)?/.exec(route.request().url());
    const name = match[1] ? await targetOf(decodeURIComponent(match[1])) : 'local';
    if (match[2]) {
      const ports = PORTS[name] ?? [{ port: 22, addresses: ['0.0.0.0', '::'], process: 'sshd' }];
      return route.fulfill({ json: { status: 'ok', tool: 'ss', ports } });
    }
    return route.fulfill({ json: name.startsWith('web-') ? WEB_CONTAINERS(name) : NO_ENVIRONMENTS() });
  });

}

/**
 * The host monitor's readings. Kept to the one shot that needs it: routing a
 * WebSocket swaps the page's WebSocket class for Playwright's stand-in, which
 * noVNC refuses ("Raw channel missing property: send").
 */
export async function fakeHostMonitor(page) {
  // The monitor's host list is the sandbox's own; only the readings change.
  await page.routeWebSocket(/\/ws\/host-monitor/, (ws) => {
    const server = ws.connectToServer();
    const names = new Map();
    ws.onMessage((message) => server.send(message));
    server.onMessage((raw) => {
      const message = JSON.parse(raw);
      if (message.op === 'hosts') {
        for (const host of message.hosts) names.set(host.id, host.kind === 'local' ? 'local' : host.target);
      }
      if (message.op === 'sample') {
        const name = names.get(message.id) ?? 'local';
        message.sample = sampleFor(name);
        if (message.latencyMs !== undefined) message.latencyMs = name === 'local' ? 0 : 14 + (name.length * 7) % 40;
      }
      ws.send(JSON.stringify(message));
    });
  });
}
