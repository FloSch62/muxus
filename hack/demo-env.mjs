// A self-contained demo environment for the documentation screenshots.
//
//   node hack/demo-env.mjs          # start it and print the URL, then wait
//   node hack/capture.mjs           # start it, drive it, write the screenshots
//
// Nothing here touches your real machine: the server runs with HOME pointing at
// a throwaway directory, so the ssh config, known_hosts, key scan and the local
// database all live under /tmp. Every "remote" host is a small in-process SSH
// server (shell + SFTP + forwarding) listening on loopback.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { chartPng, kittySequence } from './demo-image.mjs';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const ssh2 = require('ssh2');
const pty = require('node-pty');

const { Server, utils } = ssh2;
const { STATUS_CODE: STATUS, OPEN_MODE } = utils.sftp;

export const DEMO_ROOT = process.env.MUXUS_DEMO_DIR || path.join(os.tmpdir(), 'muxus-demo');
const HOME = path.join(DEMO_ROOT, 'home');
const REMOTES = path.join(DEMO_ROOT, 'remotes');
const SSH_PORT_BASE = Number(process.env.MUXUS_DEMO_SSH_PORT || 2200);
const APP_PORT = Number(process.env.MUXUS_DEMO_PORT || 3099);

/**
 * The cast. Everything a screenshot shows is invented here — aliases,
 * usernames, folders and the prompts inside the terminals.
 */
export const DEMO_HOSTS = [
  { alias: 'web-01', hostname: 'web-01.prod.internal', user: 'deploy', prompt: 'web-01', folder: 'Production/Web', color: '#3b82f6' },
  { alias: 'web-02', hostname: 'web-02.prod.internal', user: 'deploy', prompt: 'web-02', folder: 'Production/Web', color: '#3b82f6' },
  { alias: 'cache-01', hostname: 'cache-01.prod.internal', user: 'deploy', prompt: 'cache-01', folder: 'Production', color: '#3b82f6' },
  { alias: 'bastion', hostname: 'bastion.example.net', user: 'jump', prompt: 'bastion', folder: 'Production', color: '#ef4444', auth: 'keyboard-interactive' },
  { alias: 'db-01', hostname: 'db-01.prod.internal', user: 'postgres', prompt: 'db-01', folder: 'Production/Data', jump: 'bastion' },
  { alias: 'build-01', hostname: 'build-01.lab.internal', user: 'ci', prompt: 'build-01', folder: 'Lab', color: '#22c55e' },
  { alias: 'lab-leaf-01', hostname: 'leaf-01.lab.internal', user: 'admin', prompt: 'leaf-01', folder: 'Lab/Fabric', color: '#a855f7' },
  { alias: 'lab-spine-01', hostname: 'spine-01.lab.internal', user: 'admin', prompt: 'spine-01', folder: 'Lab/Fabric', color: '#a855f7' },
];

/** Hosts that only ever exist on screen — never dialled, so they can look real. */
export const SHOWCASE_HOSTS = [
  {
    alias: 'db-primary',
    displayName: 'db-primary (eu-central)',
    folder: 'Production/Data',
    lines: [
      '    HostName db-primary.prod.internal',
      '    User postgres',
      '    Port 22',
      '    IdentityFile ~/.ssh/id_prod_ed25519',
      '    ProxyJump bastion',
      '    LocalForward 15432 127.0.0.1:5432',
      '    ForwardAgent yes',
      '    ServerAliveInterval 30',
    ],
  },
];

const REMOTE_TREE = {
  'web-01': {
    'docker-compose.yml': `services:
  edge:
    image: ghcr.io/acme/edge:2.8.1
    restart: unless-stopped
    ports:
      - "80:8080"
    environment:
      LOG_LEVEL: info
      UPSTREAM: http://cache-01:6379
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8080/healthz"]
      interval: 10s
`,
    'deploy.sh': `#!/usr/bin/env bash
set -euo pipefail

RELEASE="\${1:-latest}"
echo "==> pulling edge:\${RELEASE}"
docker compose pull edge
echo "==> restarting"
docker compose up -d --no-deps edge
docker compose ps
`,
    'README.md': `# web-01

Front-end node behind the load balancer.

- \`deploy.sh <tag>\` rolls a new edge release
- \`docker compose logs -f edge\` tails the access log
- metrics: http://web-01:9100/metrics
`,
    conf: {
      'nginx.conf': `worker_processes auto;

events { worker_connections 4096; }

http {
    access_log /var/log/nginx/access.log combined;
    sendfile on;

    upstream edge {
        server 127.0.0.1:8080 max_fails=3 fail_timeout=15s;
    }

    server {
        listen 80;
        server_name web-01;

        location / {
            proxy_pass http://edge;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }
    }
}
`,
      'edge.env': 'LOG_LEVEL=info\nUPSTREAM=http://cache-01:6379\nTIMEOUT=5s\n',
    },
    logs: {
      'access.log': Array.from(
        { length: 40 },
        (_, i) => `10.20.${i % 5}.${i + 3} - - [12/Mar/2026:09:${String(i % 60).padStart(2, '0')}:11] "GET /healthz HTTP/1.1" 200 12`,
      ).join('\n'),
      'error.log': 'no errors in the last 24h\n',
    },
    backups: {},
  },
};

/** Sandbox plumbing that a screenshot of the file browser should never show. */
const HIDDEN_REMOTE_ENTRIES = new Set([
  '.muxus-demo-rc',
  '.bash_profile',
  '.bash_history',
  '.sudo_as_admin_successful',
  '.demo',
  '.cache',
]);

const SHELL_RC = `
export PATH="$HOME/bin:$PATH"
export PS1='\\[\\e[38;5;114m\\]__USER__@__HOST__\\[\\e[0m\\]:\\[\\e[38;5;75m\\]\\w\\[\\e[0m\\]\\$ '
alias ls='ls --color=auto'
# The scratch files belong to whoever runs the capture; screenshots should not
# say so, and the demo host has its own user anyway.
ll() {
  command ls -lh --color=auto "$@" | sed -E "s/ $(id -un) +$(id -gn) / __USER__ __USER__ /"
}
printf '\\e[2J\\e[H'
`;

/** Commands the screenshots run, so terminals show something worth reading. */
function demoCommands(host) {
  return {
    status: `#!/usr/bin/env bash
printf '\\e[1m%-18s %-9s %-8s %s\\e[0m\\n' UNIT STATE CPU MEMORY
printf '%-18s \\e[32m%-9s\\e[0m %-8s %s\\n' edge.service active 3.1% 218M
printf '%-18s \\e[32m%-9s\\e[0m %-8s %s\\n' nginx.service active 0.4% 24M
printf '%-18s \\e[32m%-9s\\e[0m %-8s %s\\n' node-exporter active 0.2% 18M
printf '%-18s \\e[33m%-9s\\e[0m %-8s %s\\n' backup.timer waiting - -
echo
printf 'host      \\e[1m${host.prompt}\\e[0m   uptime \\e[1m12 days\\e[0m   load \\e[1m0.31 0.28 0.22\\e[0m\\n'
`,
    plot: `#!/usr/bin/env bash
echo "p95 request latency — last 6 hours"
cat "$HOME/.demo/latency.kitty"
echo "median 41ms   p95 96ms   p99 184ms"
`,
    tailaccess: `#!/usr/bin/env bash
tail -n 12 "$HOME/logs/access.log"
`,
  };
}

// ---------------------------------------------------------------------------
// Fake HOME
// ---------------------------------------------------------------------------

async function writeFile(file, content, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, mode ? { mode } : undefined);
}

async function writeTree(root, tree) {
  await fs.mkdir(root, { recursive: true });
  for (const [name, value] of Object.entries(tree)) {
    const target = path.join(root, name);
    if (typeof value === 'string') await writeFile(target, value);
    else await writeTree(target, value);
  }
}

function sshConfig(hosts) {
  const lines = [
    '# Your OpenSSH configuration — Muxus reads it and edits blocks in place.',
    '',
    'Host *',
    '    ServerAliveInterval 30',
    '    ServerAliveCountMax 3',
    '',
    'Include ~/.ssh/config.d/lab.conf',
    '',
  ];
  for (const host of hosts.filter((h) => !h.alias.startsWith('lab-'))) {
    lines.push(`Host ${host.alias}`);
    lines.push(`    HostName ${host.hostname}`);
    lines.push(`    User ${host.user}`);
    if (host.jump) lines.push(`    ProxyJump ${host.jump}`);
    if (host.auth !== 'keyboard-interactive') lines.push('    IdentityFile ~/.ssh/id_ed25519');
    if (host.alias === 'web-01') lines.push('    LocalForward 8080 127.0.0.1:8080');
    lines.push('');
  }
  for (const host of SHOWCASE_HOSTS) {
    lines.push(`Host ${host.alias}`, ...host.lines, '');
  }
  return lines.join('\n');
}

function labConfig(hosts) {
  const lines = ['# Lab fabric — a separate file pulled in with Include.', ''];
  for (const host of hosts.filter((h) => h.alias.startsWith('lab-'))) {
    lines.push(`Host ${host.alias}`);
    lines.push(`    HostName ${host.hostname}`);
    lines.push(`    User ${host.user}`);
    lines.push('    IdentityFile ~/.ssh/id_ed25519');
    lines.push('');
  }
  return lines.join('\n');
}

async function buildHome(hosts, keys) {
  await fs.rm(DEMO_ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(HOME, '.ssh'), { recursive: true });
  await writeFile(path.join(HOME, '.ssh', 'config'), sshConfig(hosts), 0o600);
  await writeFile(path.join(HOME, '.ssh', 'config.d', 'lab.conf'), labConfig(hosts), 0o600);
  await writeFile(path.join(HOME, '.ssh', 'id_ed25519'), keys.client.private, 0o600);
  await writeFile(path.join(HOME, '.ssh', 'id_ed25519.pub'), `${keys.client.public} demo@muxus\n`, 0o644);
  await writeFile(path.join(HOME, '.ssh', 'id_prod_ed25519'), keys.client.private, 0o600);
  await writeFile(path.join(HOME, '.ssh', 'id_prod_ed25519.pub'), `${keys.client.public} prod@muxus\n`, 0o644);
  // Trust the sandbox up front: the trust-on-first-use dialog is captured on
  // purpose in one shot, not accidentally in every other one.
  const known = hosts.map((host) => `${host.hostname} ${keys.host.public}`).join('\n');
  await writeFile(path.join(HOME, '.ssh', 'known_hosts'), `${known}\n`, 0o600);

  const kitty = kittySequence(chartPng());
  for (const host of hosts) {
    const remote = path.join(REMOTES, host.alias);
    await writeTree(remote, REMOTE_TREE[host.alias] ?? defaultRemoteTree(host));
    const rc = SHELL_RC.replaceAll('__USER__', host.user).replaceAll('__HOST__', host.prompt);
    await writeFile(path.join(remote, '.muxus-demo-rc'), rc);
    // Muxus's shell integration starts bash with its own init file, which
    // sources ~/.bash_profile — so the prompt survives that path too.
    await writeFile(path.join(remote, '.bash_profile'), rc);
    await writeFile(path.join(remote, '.demo', 'latency.kitty'), kitty);
    // Silences the "use sudo <command>" hint /etc/bash.bashrc prints into an
    // otherwise clean demo session.
    await writeFile(path.join(remote, '.sudo_as_admin_successful'), '');
    for (const [name, script] of Object.entries(demoCommands(host))) {
      await writeFile(path.join(remote, 'bin', name), script, 0o755);
    }
    if (!REMOTE_TREE[host.alias]) {
      await writeFile(path.join(remote, 'logs', 'access.log'), 'demo\n');
    }
  }
}

function defaultRemoteTree(host) {
  return {
    'README.md': `# ${host.prompt}\n\nDemo host used by the Muxus documentation screenshots.\n`,
    'notes.txt': 'nothing to see here\n',
    src: { 'main.go': 'package main\n\nfunc main() {}\n' },
  };
}

// ---------------------------------------------------------------------------
// SFTP subsystem — a thin bridge onto a real directory
// ---------------------------------------------------------------------------

function attrsFor(stat) {
  return {
    mode: stat.mode,
    uid: 1000,
    gid: 1000,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

function longname(name, stat) {
  const dir = stat.isDirectory() ? 'd' : '-';
  const size = String(stat.size).padStart(8);
  return `${dir}rw-r--r--   1 demo demo ${size} Mar 12 09:20 ${name}`;
}

/**
 * `root` is the real scratch directory; `home` is the path the client sees.
 * The two-way mapping keeps `/home/deploy/conf/nginx.conf` on screen while the
 * bytes come from /tmp — and still accepts the real paths the shell reports.
 */
function serveSftp(sftp, { root, home }) {
  const handles = new Map();
  let nextHandle = 0;

  const resolve = (given) => {
    const requested = path.posix.normalize(String(given) || '.');
    if (requested === '.' || requested === home) return root;
    // Ancestors of the scratch root are only ever stat-ed (the shell-integration
    // installer walks them); hand back the real path so it stops walking.
    if (requested.startsWith('/') && root.startsWith(`${requested}/`)) return requested;
    const relative = requested.startsWith(`${home}/`)
      ? requested.slice(home.length + 1)
      : requested.startsWith(root)
        ? path.relative(root, requested)
        : requested.replace(/^\//, '');
    const target = path.resolve(root, relative);
    return target.startsWith(root) ? target : root;
  };
  const display = (target) => {
    const relative = path.relative(root, target).split(path.sep).join('/');
    return relative ? `${home}/${relative}` : home;
  };
  const open = (value) => {
    const id = Buffer.alloc(4);
    id.writeUInt32BE(nextHandle, 0);
    handles.set(nextHandle++, value);
    return id;
  };
  const lookup = (handle) => handles.get(handle.readUInt32BE(0));
  const fail = (reqid, err) => sftp.status(reqid, err?.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : STATUS.FAILURE);

  sftp.on('REALPATH', async (reqid, given) => {
    try {
      const target = resolve(given);
      const stat = await fs.stat(target);
      sftp.name(reqid, [{ filename: display(target), longname: display(target), attrs: attrsFor(stat) }]);
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('OPENDIR', async (reqid, given) => {
    try {
      const target = resolve(given);
      const entries = await fs.readdir(target);
      sftp.handle(reqid, open({ kind: 'dir', target, entries, done: false }));
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('READDIR', async (reqid, handle) => {
    const state = lookup(handle);
    if (!state || state.kind !== 'dir') return sftp.status(reqid, STATUS.FAILURE);
    if (state.done) return sftp.status(reqid, STATUS.EOF);
    state.done = true;
    const names = [];
    for (const name of state.entries) {
      if (HIDDEN_REMOTE_ENTRIES.has(name)) continue;
      try {
        const stat = await fs.lstat(path.join(state.target, name));
        names.push({ filename: name, longname: longname(name, stat), attrs: attrsFor(stat) });
      } catch {
        /* raced away */
      }
    }
    sftp.name(reqid, names);
  });

  const statLike = (event, method) =>
    sftp.on(event, async (reqid, given) => {
      try {
        sftp.attrs(reqid, attrsFor(await fs[method](resolve(given))));
      } catch (err) {
        fail(reqid, err);
      }
    });
  statLike('STAT', 'stat');
  statLike('LSTAT', 'lstat');

  sftp.on('FSTAT', async (reqid, handle) => {
    const state = lookup(handle);
    if (!state) return sftp.status(reqid, STATUS.FAILURE);
    try {
      sftp.attrs(reqid, attrsFor(await fs.stat(state.target)));
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('OPEN', async (reqid, filename, flags) => {
    const target = resolve(filename);
    const write = !!(flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC));
    try {
      const file = await fs.open(target, write ? 'w+' : 'r');
      sftp.handle(reqid, open({ kind: 'file', target, file }));
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('READ', async (reqid, handle, offset, length) => {
    const state = lookup(handle);
    if (!state || state.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await state.file.read(buffer, 0, length, offset);
    if (bytesRead === 0) return sftp.status(reqid, STATUS.EOF);
    sftp.data(reqid, buffer.subarray(0, bytesRead));
  });

  sftp.on('WRITE', async (reqid, handle, offset, data) => {
    const state = lookup(handle);
    if (!state || state.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE);
    try {
      await state.file.write(data, 0, data.length, offset);
      sftp.status(reqid, STATUS.OK);
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('CLOSE', async (reqid, handle) => {
    const key = handle.readUInt32BE(0);
    const state = handles.get(key);
    handles.delete(key);
    if (state?.file) await state.file.close().catch(() => undefined);
    sftp.status(reqid, STATUS.OK);
  });

  const simple = (event, run) =>
    sftp.on(event, async (reqid, ...args) => {
      try {
        await run(...args.map((arg) => (typeof arg === 'string' ? resolve(arg) : arg)));
        sftp.status(reqid, STATUS.OK);
      } catch (err) {
        fail(reqid, err);
      }
    });
  simple('MKDIR', (target) => fs.mkdir(target, { recursive: true }));
  simple('RMDIR', (target) => fs.rmdir(target));
  simple('REMOVE', (target) => fs.unlink(target));
  simple('RENAME', (from, to) => fs.rename(from, to));
  simple('SETSTAT', () => Promise.resolve());
  simple('FSETSTAT', () => Promise.resolve());
}

// ---------------------------------------------------------------------------
// The sandbox SSH servers
// ---------------------------------------------------------------------------

function startSshd(host, keys, hostMap) {
  const root = path.join(REMOTES, host.alias);
  const home = `/home/${host.user}`;
  const shellEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: root,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    SHELL: '/usr/bin/bash',
    HOSTNAME: host.prompt,
    MUXUS_DEMO: '1',
  };

  const server = new Server({ hostKeys: [keys.host.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (host.auth === 'keyboard-interactive') {
        // The bastion asks for a code, so the interactive-auth dialog has
        // something honest to show.
        if (ctx.method === 'keyboard-interactive') {
          return ctx.prompt(
            [{ prompt: 'Verification code: ', echo: false }],
            'Two-factor authentication',
            'This host requires a one-time code.',
            () => ctx.accept(),
          );
        }
        return ctx.reject(['keyboard-interactive']);
      }
      if (ctx.method === 'publickey') return ctx.accept();
      if (ctx.method === 'none') return ctx.reject(['publickey']);
      return ctx.accept();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let size = { cols: 120, rows: 32 };
        let shell;
        let ptyRequested = false;

        session.on('pty', (accept, _reject, info) => {
          size = { cols: info.cols || 120, rows: info.rows || 32 };
          ptyRequested = true;
          accept?.();
        });
        session.on('window-change', (accept, _reject, info) => {
          size = { cols: info.cols || size.cols, rows: info.rows || size.rows };
          shell?.resize(size.cols, size.rows);
          accept?.();
        });
        /** Attach a real pty to a channel — both `shell` and `exec` need one. */
        const attachPty = (stream, args) => {
          shell = pty.spawn('/usr/bin/bash', args, {
            name: 'xterm-256color',
            cols: size.cols,
            rows: size.rows,
            cwd: root,
            env: shellEnv,
          });
          shell.onData((data) => {
            if (stream.writable) stream.write(data);
          });
          shell.onExit(() => stream.end());
          stream.on('data', (data) => shell.write(data.toString('utf8')));
          stream.on('close', () => shell.kill());
        };

        session.on('shell', (accept) => {
          attachPty(accept(), ['--noprofile', '--rcfile', path.join(root, '.muxus-demo-rc'), '-i']);
        });
        // Muxus probes the shell over exec and then starts the session with a
        // pty-backed exec, so this has to be a terminal too.
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          if (ptyRequested) return attachPty(stream, ['-c', info.command]);
          const child = spawn('/usr/bin/bash', ['-c', info.command], { cwd: root, env: shellEnv });
          child.stdout.pipe(stream);
          child.stderr.pipe(stream.stderr);
          child.on('close', (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
        });
        session.on('sftp', (accept) => serveSftp(accept(), { root, home }));
      });

      // Forwarding: what makes ProxyJump chains and the tunnel panel real. A
      // jump target is a demo hostname too, so it needs the same mapping the
      // Go server got through MUXUS_DEMO_HOSTMAP.
      client.on('tcpip', (accept, reject, info) => {
        const mapped = hostMap[info.destIP];
        const socket = net.connect(mapped ?? info.destPort, mapped ? '127.0.0.1' : info.destIP, () => {
          const channel = accept();
          channel.pipe(socket).pipe(channel);
        });
        socket.on('error', () => reject());
      });
      client.on('request', (accept, reject, name) => {
        if (name === 'tcpip-forward') accept?.();
        else reject?.();
      });
    });

    client.on('error', () => undefined);
  });

  return new Promise((resolve) => {
    server.listen(host.port, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/app/info`, { headers: { authorization: 'Bearer dev' } });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muxus server did not start on ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** ssh2's ed25519 generator occasionally emits a key it cannot parse back. */
function generateKeyPair() {
  for (let attempt = 0; attempt < 16; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error('could not generate a usable ed25519 key pair');
}

/** Fail loudly rather than talking to a server left behind by an earlier run. */
async function assertPortFree(port) {
  const free = await new Promise((resolve) => {
    const probe = net.connect(port, '127.0.0.1');
    probe.on('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.on('error', () => resolve(true));
  });
  if (!free) {
    throw new Error(
      `port ${port} is already in use — a previous demo server is still running (kill it, or set MUXUS_DEMO_PORT)`,
    );
  }
}

/** Boot the sandbox: sshds, a fake HOME and a muxus server bound to it.
 *  MUXUS_SERVER_BIN can point at an alternative Go binary. */
export async function startDemoEnv() {
  const serverBin = process.env.MUXUS_SERVER_BIN || path.join(process.cwd(), 'build', 'muxus');
  await fs.access(serverBin, fsConstants.X_OK).catch(() => {
    throw new Error(`Muxus binary not executable: ${serverBin} (build first: pnpm build)`);
  });
  await assertPortFree(APP_PORT);

  const keys = { host: generateKeyPair(), client: generateKeyPair() };
  const hosts = DEMO_HOSTS.map((host, index) => ({ ...host, port: SSH_PORT_BASE + index + 1 }));
  const hostMap = Object.fromEntries(hosts.map((host) => [host.hostname, host.port]));
  await buildHome(hosts, keys);

  const sshds = await Promise.all(hosts.map((host) => startSshd(host, keys, hostMap)));

  const server = spawn(
    serverBin,
    ['serve', '--port', String(APP_PORT)],
    {
      env: {
        ...process.env,
        MUXUS_DEMO_HOSTMAP: JSON.stringify(hostMap),
        HOME,
        XDG_DATA_HOME: path.join(HOME, '.local', 'share'),
        XDG_CONFIG_HOME: path.join(HOME, '.config'),
        ZDOTDIR: HOME,
        MUXUS_DEV: '1',
        MUXUS_NO_OPEN: '1',
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const echo = (chunk) => {
    if (process.env.MUXUS_DEMO_VERBOSE) process.stderr.write(chunk);
  };
  server.stdout.on('data', echo);
  server.stderr.on('data', echo);

  // A killed capture must not leave a server behind holding the port — the next
  // run would silently talk to it, with a home directory that no longer exists.
  const reap = () => server.kill('SIGKILL');
  process.once('exit', reap);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      reap();
      process.exit(1);
    });
  }

  const url = `http://127.0.0.1:${APP_PORT}`;
  await waitForServer(url);
  await seed(url, hosts);

  return {
    url,
    token: 'dev',
    home: HOME,
    hosts,
    async stop() {
      server.kill('SIGTERM');
      for (const sshd of sshds) sshd.close();
      await new Promise((r) => setTimeout(r, 200));
    },
  };
}

/** Folders, colours and a couple of saved tunnels — the state a real user has. */
async function seed(url, hosts) {
  const api = (route, method, body) =>
    fetch(`${url}${route}`, {
      method,
      headers: { authorization: 'Bearer dev', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${await res.text()}`);
      return res.status === 204 ? null : res.json();
    });

  for (const host of hosts) {
    await api(`/api/ssh/config/hosts/${host.alias}/metadata`, 'PATCH', {
      group: host.folder,
      color: host.color ?? null,
    });
  }
  for (const host of SHOWCASE_HOSTS) {
    await api(`/api/ssh/config/hosts/${host.alias}/metadata`, 'PATCH', {
      group: host.folder,
      displayName: host.displayName ?? null,
    });
  }

  // Logging is off on a fresh install; the demo turns it on so the history
  // dialog has sessions to show.
  await api('/api/session-history/policy?profileKey=*', 'PUT', {
    enabled: true,
    captureInput: false,
    maxPartBytes: 5 * 1024 * 1024,
    maxParts: 10,
  });

  await api('/api/profiles', 'PUT', {
    name: 'core-switch (console)',
    profile: { kind: 'telnet', host: '192.0.2.20', port: 23 },
  });
  await api('/api/profiles', 'PUT', {
    name: 'lab-console',
    profile: {
      kind: 'serial',
      path: '/dev/ttyUSB0',
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      xon: false,
      xoff: false,
    },
  });

  const profiles = await api('/api/profiles', 'GET');
  const byName = new Map(profiles.profiles.map((p) => [p.name, p.id]));
  await api(`/api/profiles/${byName.get('core-switch (console)')}/metadata`, 'PATCH', {
    group: 'Lab/Fabric',
    color: '#eab308',
  });
  await api(`/api/profiles/${byName.get('lab-console')}/metadata`, 'PATCH', { group: 'Lab' });

  await api('/api/tunnels', 'PUT', {
    name: 'Grafana',
    target: 'web-01',
    type: 'local',
    bindPort: 3000,
    targetHost: '127.0.0.1',
    targetPort: 3000,
  });
  await api('/api/tunnels', 'PUT', {
    name: 'Postgres (via bastion)',
    target: 'bastion',
    type: 'local',
    bindPort: 15432,
    targetHost: 'db-01.prod.internal',
    targetPort: 5432,
  });
  await api('/api/tunnels', 'PUT', {
    name: 'Lab SOCKS proxy',
    target: 'bastion',
    type: 'dynamic',
    bindPort: 1080,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = await startDemoEnv();
  console.log(`Demo environment ready:  ${env.url}/?token=${env.token}`);
  console.log(`Fake HOME:               ${env.home}`);
  console.log('Press Ctrl+C to stop.');
  process.on('SIGINT', async () => {
    await env.stop();
    process.exit(0);
  });
}
