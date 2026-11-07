import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ssh2, { type Connection, type SFTPWrapper, type ServerChannel } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { savedHostHop, type SshProfile } from '@muxus/shared';
import { readHostStatsWith } from '../../../server/src/stats/host-stats.js';
import {
  commandProbeArgs,
  findSshBinary,
  savedHostOptions,
  scriptSshArgs,
  sftpSshArgs,
  sshDestination,
  SystemOpenSshSessions,
  terminalSshArgs,
} from '../../../server/src/ssh/system-openssh.js';

const { Server } = ssh2;
const OPEN = ssh2.utils.sftp.STATUS_CODE;
const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

const alias: SshProfile = { kind: 'ssh', target: 'build-box' };
const saved: SshProfile = {
  kind: 'ssh',
  profileId: 'p1',
  useConfig: false,
  target: 'alice@build.example.com:2200',
};

describe('ssh arguments', () => {
  it('leaves an ssh_config alias to its config', () => {
    expect(sshDestination(alias)).toEqual({ options: [], destination: 'build-box' });
    expect(savedHostOptions(alias)).toEqual([]);
    expect(terminalSshArgs(alias, undefined)).toEqual([
      '-o', 'EscapeChar=none',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      '--', 'build-box',
    ]);
  });

  it('takes the user and port from a saved target, with its fields winning', () => {
    expect(sshDestination(saved)).toEqual({
      options: ['-l', 'alice', '-p', '2200'],
      destination: 'build.example.com',
    });
    expect(sshDestination({ ...saved, user: 'bob', port: 22 })).toEqual({
      options: ['-l', 'bob', '-p', '22'],
      destination: 'build.example.com',
    });
  });

  it('passes a saved host\'s settings on the command line and asks for GSSAPI', () => {
    const args = savedHostOptions({
      ...saved,
      identityFiles: ['~/.ssh/a key'],
      certificateFiles: ['/certs/a b-cert.pub'],
      identitiesOnly: true,
      forwardAgent: false,
      proxyJump: ['jump1', 'jump2'],
      proxyCommand: 'nc "%h" %p',
      remoteCommand: 'date +%s',
      forwards: [
        { type: 'local', bindPort: 8080, targetHost: '::1', targetPort: 80 },
        { type: 'remote', bindPort: 9090, targetHost: 'db', targetPort: 5432 },
        { type: 'dynamic', bindPort: 1080 },
      ],
    });
    expect(args).toEqual([
      '-i', '~/.ssh/a key',
      '-o', 'CertificateFile="/certs/a b-cert.pub"',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ForwardAgent=no',
      '-J', 'jump1,jump2',
      '-o', 'ProxyCommand=nc "%h" %p',
      '-o', 'RemoteCommand=date +%%s',
      '-L', '8080:[::1]:80',
      '-R', '9090:db:5432',
      '-D', '1080',
      '-o', 'GSSAPIAuthentication=yes',
    ]);
  });

  it('does not ask for GSSAPI on a password-only saved host', () => {
    expect(savedHostOptions({ ...saved, passwordOnly: true })).toEqual([
      '-o', 'PubkeyAuthentication=no',
      '-o', 'PreferredAuthentications=keyboard-interactive,password',
    ]);
  });

  it('shares the login with the file browser and leaves the config out of its session', () => {
    expect(terminalSshArgs(alias, '/tmp/d/c')).toEqual(
      expect.arrayContaining(['ControlMaster=yes', 'ControlPath=/tmp/d/c', 'ControlPersist=60']),
    );
    const args = sftpSshArgs(alias, '/tmp/d/c');
    expect(args).toEqual(
      expect.arrayContaining(['-s', 'ControlMaster=no', 'ControlPath=/tmp/d/c', 'RemoteCommand=none', 'BatchMode=yes']),
    );
    expect(args.slice(-3)).toEqual(['--', 'build-box', 'sftp']);
  });
});

describe('ssh arguments for background jobs and containers', () => {
  it('feeds scripts over the shared login', () => {
    const args = scriptSshArgs(alias, '/tmp/d/c');
    expect(args).toEqual(expect.arrayContaining(['ControlMaster=no', 'ControlPath=/tmp/d/c', 'BatchMode=yes']));
    expect(args.slice(-3)).toEqual(['--', 'build-box', 'sh -s']);
  });

  it('asks whether the host runs commands on a connection of its own', () => {
    const args = commandProbeArgs({ ...saved, forwards: [{ type: 'dynamic', bindPort: 1080 }] });
    expect(args).toEqual(
      expect.arrayContaining(['ControlMaster=no', 'ControlPath=none', 'BatchMode=yes', 'ClearAllForwardings=yes']),
    );
    expect(args.join(' ')).not.toContain('muxus-ssh');
    // A saved host's own settings can only be reached through its options.
    expect(args).toEqual(expect.arrayContaining(['-l', 'alice', '-p', '2200', 'GSSAPIAuthentication=yes']));
    expect(args.at(-1)).toBe('echo "muxus$((40+2))"');
  });

  it('enters a container with a forced terminal, whatever the host\'s settings say', () => {
    const args = terminalSshArgs(
      {
        ...saved,
        remoteCommand: 'tmux',
        environment: { kind: 'container', runtime: 'docker', container: 'web', shell: 'bash' },
      },
      undefined,
    );
    expect(args.indexOf('RemoteCommand=none')).toBeLessThan(args.indexOf('RemoteCommand=tmux'));
    expect(args).toContain('RequestTTY=force');
    expect(args.at(-1)).toContain('docker');
    expect(args.at(-1)).toContain('exec');
    expect(args.at(-2)).toBe('build.example.com');
  });
});

describe('findSshBinary', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-find-ssh-'));
  // The host's own platform, since the program has to exist on its file system.
  const program = path.join(dir, process.platform === 'win32' ? 'ssh.exe' : 'ssh');
  writeFileSync(program, '#!/bin/sh\n', { mode: 0o755 });

  it('searches PATH', () => {
    const missing = path.join(dir, 'nonexistent');
    expect(findSshBinary({ PATH: `${missing}${path.delimiter}${dir}` })).toBe(program);
  });

  it('reports nothing when there is no program', () => {
    expect(findSshBinary({ SystemRoot: '/nonexistent' }, 'win32')).toBeUndefined();
  });
});

const sshProgram = findSshBinary();
const runsSsh = process.platform !== 'win32' && !!sshProgram && spawnSync(sshProgram, ['-V']).status === 0;

describe.skipIf(!runsSsh)('a session through the real ssh program', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  /** A server that accepts anyone, greets each shell, and answers SFTP realpath. */
  async function startServer(
    onExit?: (end: (code: number) => void) => void,
    onExec?: (command: string, channel: ServerChannel) => boolean,
  ) {
    const server = new Server(
      { hostKeys: [HOST_KEY] },
      (client: Connection) => {
        client.on('authentication', (ctx) => ctx.accept());
        client.on('error', () => undefined);
        client.on('ready', () => {
          client.on('session', (accept) => {
            const session = accept();
            session.on('pty', (acceptPty) => acceptPty?.());
            session.on('shell', (acceptShell) => {
              const channel: ServerChannel = acceptShell();
              channel.write('hello from the shell\r\n');
              channel.on('data', (data: Buffer) => channel.write(data));
              const end = (code: number) => {
                channel.exit(code);
                channel.end();
              };
              onExit?.(end);
            });
            session.on('exec', (acceptExec, reject, info) => {
              if (!onExec) {
                reject?.();
                return;
              }
              const channel: ServerChannel = acceptExec();
              if (!onExec(info.command, channel)) {
                channel.exit(127);
                channel.end();
              }
            });
            session.on('sftp', (acceptSftp) => {
              const sftp: SFTPWrapper = acceptSftp();
              sftp.on('REALPATH', (id: number, name: string) => {
                sftp.name(id, [{ filename: `/home/test/${name}`, longname: '', attrs: {} as never }]);
              });
              sftp.on('STAT', (id: number) => sftp.status(id, OPEN.NO_SUCH_FILE));
            });
          });
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    return (server.address() as AddressInfo).port;
  }

  function sessions() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'muxus-system-ssh-'));
    const config = path.join(dir, 'config');
    writeFileSync(
      config,
      'Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n',
    );
    const registry = new SystemOpenSshSessions({ extraArgs: ['-F', config] });
    cleanups.push(() => {
      registry.closeAll();
      rmSync(dir, { recursive: true, force: true });
    });
    return registry;
  }

  // Exactly what mkdtemp makes: other test files use names that start the same way.
  const controlDirs = () => new Set(readdirSync('/tmp').filter((name) => /^muxus-ssh-[A-Za-z0-9]{6}$/.test(name)));

  function output(session: { onData(listener: (data: Buffer) => void): () => void }) {
    let text = '';
    session.onData((data) => {
      text += data.toString('utf8');
    });
    return {
      waitFor: (expected: string) =>
        expect.poll(() => text, { timeout: 10_000 }).toContain(expected),
    };
  }

  const profile = (port: number): SshProfile => ({
    kind: 'ssh',
    profileId: 'p1',
    useConfig: false,
    target: '127.0.0.1',
    port,
  });

  it('runs the terminal, shares its login with SFTP, and cleans up', async () => {
    const before = controlDirs();
    const port = await startServer();
    const registry = sessions();
    const session = registry.start(profile(port), 80, 24, true);
    expect(session.sftpAvailable).toBe(true);
    const created = [...controlDirs()].filter((name) => !before.has(name));
    expect(created).toHaveLength(1);

    const terminal = output(session);
    await terminal.waitFor('hello from the shell');
    session.write(Buffer.from('typed text\r'));
    await terminal.waitFor('typed text');

    const lease = registry.acquire(session.id);
    expect(lease).toBeDefined();
    const sftp = await lease!.connection.sftp();
    const home = await new Promise<string>((resolve, reject) =>
      sftp.realpath('.', (err, resolved) => (err ? reject(err) : resolve(resolved))),
    );
    expect(home).toBe('/home/test/.');
    // One SFTP session serves every file request.
    expect(await lease!.connection.sftp()).toBe(sftp);
    const closed = new Promise<void>((resolve) => lease!.connection.onClose(() => resolve()));

    // A running transfer outlives the tab, as it does on a built-in connection.
    session.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stillThere = await new Promise<string>((resolve, reject) =>
      sftp.realpath('after-tab', (err, resolved) => (err ? reject(err) : resolve(resolved))),
    );
    expect(stillThere).toBe('/home/test/after-tab');

    lease!.release();
    await closed;
    expect(registry.acquire(session.id)).toBeUndefined();
    await expect.poll(() => existsSync(path.join('/tmp', created[0]!)), { timeout: 10_000 }).toBe(false);
  }, 30_000);

  it('leaves nothing behind when the server shuts down', async () => {
    const before = controlDirs();
    const port = await startServer();
    const registry = sessions();
    const session = registry.start(profile(port), 80, 24, true);
    await output(session).waitFor('hello from the shell');
    const created = [...controlDirs()].filter((name) => !before.has(name));
    expect(created).toHaveLength(1);

    registry.closeAll();
    // Already gone on return: a shutting-down server gets no later turn.
    expect(existsSync(path.join('/tmp', created[0]!))).toBe(false);
  }, 30_000);

  it('runs scripts over the shared login and reads statistics with them', async () => {
    const scripts: string[] = [];
    let probes = 0;
    const port = await startServer(undefined, (command, channel) => {
      if (command.includes('muxus$((40+2))')) {
        probes += 1;
        channel.write('muxus42\n');
        channel.exit(0);
        channel.end();
        return true;
      }
      if (command !== 'sh -s') return false;
      let script = '';
      channel.on('data', (data: Buffer) => {
        script += data.toString('utf8');
      });
      channel.on('end', () => {
        scripts.push(script);
        channel.write('banner\nnot statistics\n');
        channel.exit(0);
        channel.end();
      });
      return true;
    });
    const registry = sessions();
    const session = registry.start(profile(port), 80, 24, true);
    const terminal = output(session);
    await terminal.waitFor('hello from the shell');

    const lease = registry.acquire(session.id)!;
    expect(await lease.connection.runsCommands()).toBe(true);
    // One question per session, however often the status bar polls.
    expect(await lease.connection.runsCommands()).toBe(true);
    expect(probes).toBe(1);
    expect(await lease.connection.runScript('echo hi\n')).toContain('not statistics');
    expect(scripts).toEqual(['echo hi\n']);
    // A reading the host answers without its markers is reported as unsupported.
    expect(await readHostStatsWith(lease.connection.runScript)).toEqual({ supported: false });

    session.write(Buffer.from('still here\r'));
    await terminal.waitFor('still here');
    lease.release();
  }, 30_000);

  it('does not count a device CLI that echoes the question as running commands', async () => {
    const port = await startServer(undefined, (command, channel) => {
      channel.write(`% Invalid input: ${command}\n`);
      channel.exit(0);
      channel.end();
      return true;
    });
    const registry = sessions();
    const session = registry.start(profile(port), 80, 24, true);
    await output(session).waitFor('hello from the shell');
    expect(await registry.acquire(session.id)!.connection.runsCommands()).toBe(false);
  }, 30_000);

  it('keeps the terminal when a device refuses to run commands', async () => {
    const port = await startServer();
    const registry = sessions();
    const session = registry.start(profile(port), 80, 24, true);
    const terminal = output(session);
    await terminal.waitFor('hello from the shell');
    expect(await registry.acquire(session.id)!.connection.runsCommands()).toBe(false);
    session.write(Buffer.from('still here\r'));
    await terminal.waitFor('still here');
  }, 30_000);

  it('has no commands or shared login in a session without SFTP', async () => {
    const port = await startServer();
    const registry = sessions();
    const session = registry.start(profile(port), 80, 24, false);
    await output(session).waitFor('hello from the shell');
    const { connection } = registry.acquire(session.id)!;
    expect(await connection.runsCommands()).toBe(false);
    await expect(connection.runScript('true\n')).rejects.toThrow('not available');
  }, 30_000);

  it('reports the end of the remote shell as a normal close', async () => {
    let endShell: ((code: number) => void) | undefined;
    const port = await startServer((end) => {
      endShell = end;
    });
    const session = sessions().start(profile(port), 80, 24, true);
    const closed = new Promise<void>((resolve) => session.onClose(resolve));
    const terminal = output(session);
    await terminal.waitFor('hello from the shell');
    endShell!(3);
    await closed;
  }, 30_000);

  it('reports ssh\'s own failure as an error', async () => {
    const session = sessions().start(profile(1), 80, 24, true);
    const failure = await new Promise<Error>((resolve) => session.onError(resolve));
    expect(failure.message).toContain('could not connect');
  }, 30_000);

  it('runs without a control socket when SFTP is off', async () => {
    const port = await startServer();
    const before = controlDirs();
    const registry = sessions();
    const session = registry.start(profile(port), 80, 24, false);
    expect(session.sftpAvailable).toBe(false);
    expect(controlDirs()).toEqual(before);
    await output(session).waitFor('hello from the shell');
    await expect(registry.acquire(session.id)!.connection.sftp()).rejects.toThrow('not available');
  }, 30_000);

  it('refuses a jump through a host saved in Muxus', () => {
    expect(() =>
      sessions().start({ ...saved, proxyJump: [savedHostHop('other')] }, 80, 24, true),
    ).toThrow('ssh program cannot reach');
  });

  it('refuses a link that pins a host key', () => {
    expect(() =>
      sessions().start({ ...alias, hostKeyFingerprint: 'SHA256:abc' }, 80, 24, true),
    ).toThrow('pins a host key');
  });
});
