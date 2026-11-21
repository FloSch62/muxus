import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { finished, fixture, inContainer, recordingIo, server, ssh, terminalOutput, useScratchHome } from './harness.js';

const ALICE = ['User alice', 'IdentitiesOnly yes', `IdentityFile ${fixture('id_ed25519')}`];

describe('sessions on OpenSSH', () => {
  const home = useScratchHome();

  it('opens an integrated shell, runs commands in it and reports how it ended', async () => {
    const io = recordingIo();
    const shell = await home.manager({ box: ALICE }).connectShell(ssh('box'), io.io, 100, 30, 'xterm-256color');
    expect(shell.transport).toBe('new');
    expect(shell.summary).toMatchObject({
      user: 'alice',
      host: '127.0.0.1',
      port: server.port,
      shared: false,
      authMethods: ['publickey'],
      sftp: true,
      compression: 'off',
      x11: 'off',
      agentForwarding: 'off',
    });
    expect(shell.summary.serverSoftware).toMatch(/^OpenSSH_/);
    expect(shell.summary.kex).toBeTruthy();
    expect(shell.summary.cipher).toBeTruthy();

    const output = terminalOutput(shell.stream);
    const exit = new Promise<number | null>((resolve) => shell.stream.once('exit', resolve));
    const closed = new Promise<void>((resolve) => shell.stream.once('close', () => resolve()));
    shell.stream.write('stty size\r');
    await output.waitFor('30 100');
    shell.stream.resize(132, 43);
    shell.stream.write('stty size\r');
    await output.waitFor('43 132');
    // The prompt marks of the shell integration, installed over SFTP on the way in.
    expect(output.text()).toContain('\x1b]133;A');
    expect(inContainer('ls', '/home/alice/.cache/muxus/shell-integration').trim()).not.toBe('');
    shell.stream.write('exit 3\r');
    expect(await exit).toBe(3);
    await closed;
    shell.lease.release();
  });

  it('shares one connection between two terminals and keeps their output apart', async () => {
    const manager = home.manager({ box: ALICE });
    const first = await manager.connectShell(ssh('box'), recordingIo().io, 80, 24, 'xterm-256color');
    const second = await manager.connectShell(ssh('box'), recordingIo().io, 80, 24, 'xterm-256color');
    expect(second.transport).toBe('shared');
    expect(second.lease.connection.id).toBe(first.lease.connection.id);

    const one = terminalOutput(first.stream);
    const two = terminalOutput(second.stream);
    first.stream.write('echo first-$((40+2))\r');
    second.stream.write('echo second-$((50+5))\r');
    await one.waitFor('first-42');
    await two.waitFor('second-55');
    expect(one.text()).not.toContain('second-55');
    expect(two.text()).not.toContain('first-42');
    for (const shell of [first, second]) {
      shell.stream.close();
      shell.lease.release();
    }
  });

  it('dials a connection of its own when the shared one takes no more sessions', async () => {
    // Two sessions per connection: the file browser's and the first terminal's.
    const manager = home.manager({ box: ['User twosessions', ...ALICE.slice(1)] });
    const io = recordingIo();
    const first = await manager.connectShell(ssh('box'), io.io, 80, 24, 'xterm-256color');
    const second = await manager.connectShell(ssh('box'), io.io, 80, 24, 'xterm-256color');
    expect(second.transport).toBe('overflow');
    expect(second.lease.connection.id).not.toBe(first.lease.connection.id);
    const output = terminalOutput(second.stream);
    second.stream.write('echo over-$((1+1))\r');
    await output.waitFor('over-2');
    for (const shell of [first, second]) {
      shell.stream.close();
      shell.lease.release();
    }
  });

  it('runs a RemoteCommand instead of the shell, with the environment the config sets', async () => {
    const shell = await home
      .manager({
        box: [...ALICE, 'RequestTTY no', 'SetEnv MUXUS_TEST=from-config', 'RemoteCommand echo "seen-$MUXUS_TEST"; echo oops >&2; exit 9'],
      })
      .connectShell(ssh('box'), recordingIo().io, 80, 24, 'xterm-256color');
    const result = await finished(shell.stream);
    expect(result).toMatchObject({ stdout: 'seen-from-config\n', stderr: 'oops\n', code: 9 });
    shell.lease.release();
  });

  it('reports the signal that ended a command', async () => {
    const lease = await home.manager({ box: ALICE }).connect(ssh('box'), recordingIo().io);
    const result = await finished(await lease.connection.transport.exec('kill -TERM $$'));
    expect(result.code).toBeNull();
    expect(result.signal).toBe('TERM');
    lease.release();
  });

  it('reaches a host through a jump host and rides that login for the next connection', async () => {
    const manager = home.manager({
      jump: ALICE,
      // From the jump host's side, the container's own sshd.
      inner: [...ALICE, 'HostName 127.0.0.1', 'Port 22', 'ProxyJump jump', 'KbdInteractiveAuthentication no'],
      other: ['User kbd', 'HostName 127.0.0.1', 'Port 22', 'ProxyJump jump'],
    });
    const io = recordingIo([['kbd-pass']]);
    const inner = await manager.connect(ssh('inner'), io.io);
    expect(inner.connection.facts.jumpHosts).toEqual(['jump']);
    const origin = await finished(await inner.connection.transport.exec('echo $SSH_CONNECTION'));
    // The far end sees the jump host as the client, not this computer.
    expect(origin.stdout).toMatch(/^127\.0\.0\.1 \d+ 127\.0\.0\.1 22/);

    // Two hosts were trusted so far: the jump host and the target behind it.
    expect(io.hostKeys.map((challenge) => challenge.hop)).toEqual(['jump', undefined]);
    const other = await manager.connect(ssh('other'), io.io);
    expect(other.connection.facts.jumpHosts).toEqual(['jump']);
    // The second host asked for its own password; the jump host asked nothing again.
    expect(io.prompts.map((prompt) => prompt.host)).toEqual(['other']);
    expect(io.hostKeys).toHaveLength(2);
    inner.release();
    other.release();
  });

  it('runs over a ProxyCommand, and says what a failing one said', async () => {
    const through = await home
      .manager({ box: [...ALICE, `ProxyCommand docker exec -i ${server.container} nc %h 22`] })
      .connect(ssh('box'), recordingIo().io);
    expect(through.connection.facts.proxyCommand).toBe(true);
    expect((await finished(await through.connection.transport.exec('whoami'))).stdout).toBe('alice\n');
    through.release();

    await expect(
      home
        .manager({ box: [...ALICE, 'ProxyCommand echo "no way to %h" >&2; exit 4'] })
        .connect(ssh('box'), recordingIo().io),
    ).rejects.toThrow('ProxyCommand failed with exit code 4: no way to 127.0.0.1');
  });

  it('compresses when the config asks for it', async () => {
    const shell = await home
      .manager({ box: [...ALICE, 'Compression yes'] })
      .connectShell(ssh('box'), recordingIo().io, 80, 24, 'xterm-256color');
    expect(shell.summary.compression).toBe('on');
    const output = terminalOutput(shell.stream);
    shell.stream.write('seq 1 20000 | tail -n 1\r');
    // The command's own line, not the echo of what was typed.
    await output.waitFor(/(?<![ 0-9])20000\r\n/);
    shell.stream.close();
    shell.lease.release();
  });

  it.each([
    ['aes256-cbc', 'diffie-hellman-group14-sha1'],
    ['3des-cbc', 'diffie-hellman-group1-sha1'],
  ])('speaks what old devices need: %s with %s', async (cipher, kex) => {
    const io = recordingIo();
    const shell = await home
      .manager({
        box: [...ALICE, `Ciphers ${cipher}`, `KexAlgorithms ${kex}`, 'MACs hmac-sha1', 'HostKeyAlgorithms ssh-rsa'],
      })
      .connectShell(ssh('box'), io.io, 80, 24, 'xterm-256color');
    expect(shell.summary).toMatchObject({ cipher, kex });
    expect(io.hostKeys[0]?.keyType).toBe('ssh-rsa');
    const output = terminalOutput(shell.stream);
    shell.stream.write('echo legacy-$((6*7))\r');
    await output.waitFor('legacy-42');
    shell.stream.close();
    shell.lease.release();
  });

  it('explains a handshake that finds no common algorithm, and notes entries it cannot offer', async () => {
    const io = recordingIo();
    await expect(
      home.manager({ box: [...ALICE, 'Ciphers aes128-cbc'] }).connect(ssh('box'), io.io),
    ).rejects.toThrow(/Handshake failed: no matching cipher — if 127\.0\.0\.1:\d+ only speaks legacy algorithms/);

    const noted = recordingIo();
    const lease = await home
      .manager({ box: [...ALICE, 'KexAlgorithms +sntrup761x25519-sha512@openssh.com'] })
      .connect(ssh('box'), noted.io);
    expect(noted.statuses).toContain(
      'KexAlgorithms: skipping sntrup761x25519-sha512@openssh.com — not supported by the SSH engine.',
    );
    lease.release();
  });

  it('gives a refused connection and an unknown name their own words', async () => {
    await expect(
      home.manager({ box: [...ALICE, 'Port 1'] }).connect(ssh('box'), recordingIo().io),
    ).rejects.toThrow('connection refused by 127.0.0.1:1 — is sshd running?');
    await expect(
      home.manager({ box: [...ALICE, 'HostName no-such-host.invalid'] }).connect(ssh('box'), recordingIo().io),
    ).rejects.toThrow('could not resolve host no-such-host.invalid');
  });
});

describe('a server that stops answering', () => {
  const home = useScratchHome();
  const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'ignore' });

  it('is marked suspect after two silent keepalive intervals, and healthy when it answers again', async () => {
    const lease = await home
      .manager({ box: [...ALICE, 'ServerAliveInterval 1', 'ServerAliveCountMax 60'] })
      .connect(ssh('box'), recordingIo().io);
    const states: string[] = [];
    lease.connection.onHealth((state) => states.push(state));
    expect(lease.connection.health()).toBe('healthy');
    docker('pause', server.container);
    try {
      await vi.waitFor(() => expect(states).toEqual(['suspect']), { timeout: 10_000, interval: 50 });
      expect(lease.connection.health()).toBe('suspect');
    } finally {
      docker('unpause', server.container);
    }
    await vi.waitFor(() => expect(states).toEqual(['suspect', 'healthy']), { timeout: 10_000, interval: 50 });
    // The connection itself came through.
    expect((await finished(await lease.connection.transport.exec('echo still-here'))).stdout).toBe('still-here\n');
    lease.release();
  });

  it('is given up after the keepalives the config allows, and everything on it hears why', async () => {
    const lease = await home
      .manager({ box: [...ALICE, 'ServerAliveInterval 1', 'ServerAliveCountMax 2'] })
      .connect(ssh('box'), recordingIo().io);
    const reason = new Promise<string | undefined>((resolve) => lease.connection.onClose(resolve));
    docker('pause', server.container);
    try {
      expect(await reason).toBe(`127.0.0.1:${server.port} stopped answering keepalives`);
    } finally {
      docker('unpause', server.container);
    }
    lease.release();
  }, 30_000);

  it('ends its sessions when it closes the connection', async () => {
    const shell = await home
      .manager({ box: ['User kbd'] })
      .connectShell(ssh('box'), recordingIo([['kbd-pass']]).io, 80, 24, 'xterm-256color');
    const output = terminalOutput(shell.stream);
    shell.stream.write('echo up-$((2+3))\r');
    await output.waitFor('up-5');
    const lost = new Promise<void>((resolve) => shell.lease.connection.onClose(() => resolve()));
    const closed = new Promise<void>((resolve) => shell.stream.once('close', () => resolve()));
    // The sshd processes serving this login, not the listening one.
    inContainer('pkill', '-u', 'kbd');
    await lost;
    await closed;
    shell.lease.release();
  });
});
