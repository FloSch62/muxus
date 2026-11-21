import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { finished, fixture, recordingIo, server, ssh, useScratchHome } from './harness.js';

const where = `127.0.0.1:${server.port}`;

/**
 * alice by password. With PAM, sshd offers its password as a keyboard-interactive
 * exchange first, the way `ssh` meets it; these tests are about the password method.
 */
const BY_PASSWORD = ['User alice', 'KbdInteractiveAuthentication no'];

/** Only this key file takes part, so each test says exactly what it logs in with. */
const keyOnly = (name: string) => ['IdentitiesOnly yes', `IdentityFile ${fixture(name)}`];

describe('logging in to OpenSSH', () => {
  const home = useScratchHome();

  it('asks about a new host key, records it, and does not ask again', async () => {
    const knownHosts = path.join(home.home, 'known_hosts-kept');
    const first = recordingIo([['alice-pass']]);
    const lease = await home.manager({ box: BY_PASSWORD }, { knownHosts }).connect(ssh('box'), first.io);
    expect(first.hostKeys).toHaveLength(1);
    expect(first.hostKeys[0]).toMatchObject({ host: '127.0.0.1', port: server.port, state: 'new' });
    expect(first.hostKeys[0]!.fingerprint).toMatch(/^SHA256:/);
    expect(first.prompts.map((prompt) => prompt.purpose)).toEqual(['ssh-password']);
    expect(lease.connection.facts.serverSoftware).toMatch(/^OpenSSH_/);
    expect(lease.connection.facts.authMethods).toEqual(['password']);
    lease.release();

    const second = recordingIo([['alice-pass']]);
    const again = await home.manager({ box: BY_PASSWORD }, { knownHosts }).connect(ssh('box'), second.io);
    expect(second.hostKeys).toEqual([]);
    again.release();
  });

  it('does not connect to a host whose key the user turns down', async () => {
    const io = recordingIo([['alice-pass']], false);
    await expect(home.manager({ box: BY_PASSWORD }).connect(ssh('box'), io.io)).rejects.toThrow(/host denied/i);
    // Nothing was asked of a server that was not trusted.
    expect(io.prompts).toEqual([]);
  });

  it('asks again after a wrong password', async () => {
    const io = recordingIo([['not-it'], ['alice-pass']]);
    const lease = await home.manager({ box: BY_PASSWORD }).connect(ssh('box'), io.io);
    expect(io.prompts.map((prompt) => prompt.prompts[0])).toEqual([
      "alice@box's password",
      'Permission denied, please try again. Password',
    ]);
    lease.release();
  });

  it('gives the login up when the password prompt is dismissed', async () => {
    const io = recordingIo();
    await expect(home.manager({ box: BY_PASSWORD }).connect(ssh('box'), io.io)).rejects.toThrow(
      'authentication cancelled',
    );
  });

  it.each([
    ['id_ed25519', 'ssh-ed25519'],
    // OpenSSH announces rsa-sha2-512, and takes no SHA-1 signature any more.
    ['id_rsa', 'rsa-sha2-512'],
  ])('logs in with the key file %s', async (name, algorithm) => {
    const io = recordingIo();
    const lease = await home.manager({ box: ['User alice', ...keyOnly(name)] }).connect(ssh('box'), io.io);
    expect(io.prompts).toEqual([]);
    expect(lease.connection.facts.authMethods).toEqual(['publickey']);
    expect(lease.connection.facts.authKeyAlgorithm).toBe(algorithm);
    lease.release();
  });

  it.each([['id_ecdsa_protected'], ['id_rsa_pem_protected'], ['id_rsa_des3']])(
    'asks for the passphrase of %s, and again after a wrong one',
    async (name) => {
      const io = recordingIo([['wrong'], ['key-passphrase']]);
      const lease = await home.manager({ box: ['User alice', ...keyOnly(name)] }).connect(ssh('box'), io.io);
      expect(io.prompts.map((prompt) => prompt.prompts[0])).toEqual([
        `Passphrase for ${name}`,
        `Bad passphrase, try again. Passphrase for ${name}`,
      ]);
      expect(lease.connection.facts.authMethods).toEqual(['publickey']);
      lease.release();
    },
  );

  it.each([
    ['id_certified', 'ssh-ed25519-cert-v01@openssh.com'],
    ['id_certified_rsa', 'rsa-sha2-512-cert-v01@openssh.com'],
  ])('logs in with the certificate of %s, which is all that lets its key in', async (name, algorithm) => {
    // Without the certificate the key is a stranger's.
    const bare = recordingIo();
    await expect(
      home
        .manager({ box: ['User alice', ...keyOnly(name), 'PasswordAuthentication no', 'KbdInteractiveAuthentication no'] })
        .connect(ssh('box'), bare.io),
    ).rejects.toThrow(`authentication to ${where} failed`);

    const io = recordingIo();
    const lease = await home
      .manager({ box: ['User alice', ...keyOnly(name), `CertificateFile ${fixture(`${name}-cert.pub`)}`] })
      .connect(ssh('box'), io.io);
    expect(io.prompts).toEqual([]);
    expect(lease.connection.facts.authMethods).toEqual(['publickey']);
    expect(lease.connection.facts.authKeyAlgorithm).toBe(algorithm);
    lease.release();
  });

  it('answers a keyboard-interactive login', async () => {
    const io = recordingIo([['kbd-pass']]);
    const lease = await home.manager({ box: ['User kbd'] }).connect(ssh('box'), io.io);
    expect(lease.connection.facts.authMethods).toEqual(['keyboard-interactive']);
    // The server's own question, recognized as the one for the account's password.
    expect(io.prompts).toEqual([{ host: 'box', prompts: ['Password: '], purpose: 'ssh-password' }]);
    lease.release();
  });

  it('asks a keyboard-interactive password again after a wrong one', async () => {
    const io = recordingIo([['not-it'], ['kbd-pass']]);
    const lease = await home.manager({ box: ['User kbd'] }).connect(ssh('box'), io.io);
    expect(lease.connection.facts.authMethods).toEqual(['keyboard-interactive']);
    expect(io.prompts).toHaveLength(2);
    lease.release();
  });

  it('logs in in two steps when the server wants a key and then a password', async () => {
    const io = recordingIo([['twostep-pass']]);
    const lease = await home
      .manager({ box: ['User twostep', ...keyOnly('id_ed25519')] })
      .connect(ssh('box'), io.io);
    expect(lease.connection.facts.authMethods).toEqual(['publickey', 'password']);
    expect(lease.connection.facts.authKeyAlgorithm).toBe('ssh-ed25519');
    lease.release();
  });

  it('says that the login failed when the server takes nothing on offer', async () => {
    const io = recordingIo([['not-it'], ['not-it'], ['not-it']]);
    await expect(
      home.manager({ box: BY_PASSWORD }).connect(ssh('box'), io.io),
    ).rejects.toThrow(`authentication to ${where} failed`);
    expect(io.prompts).toHaveLength(3);
  });
});

function commandExists(command: string): boolean {
  try {
    execFileSync(command, ['-?'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

describe.skipIf(!commandExists('ssh-agent') || !commandExists('ssh-add'))('logging in through an ssh-agent', () => {
  const home = useScratchHome();

  /** An ssh-agent of this test's own, holding one key. */
  async function startAgent(key: string): Promise<{ socket: string; agent: ChildProcess }> {
    const socket = path.join(home.home, `agent-${process.pid}-${Date.now()}.sock`);
    const agent = spawn('ssh-agent', ['-D', '-a', socket], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve) => agent.stdout!.once('data', () => resolve()));
    execFileSync('ssh-add', [fixture(key)], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' });
    return { socket, agent };
  }

  it('signs with a key the agent holds, without touching a key file', async () => {
    const { socket, agent } = await startAgent('id_rsa');
    try {
      const io = recordingIo();
      const lease = await home
        .manager({ box: ['User alice', `IdentityAgent ${socket}`] })
        .connect(ssh('box'), io.io);
      expect(lease.connection.facts.authMethods).toEqual(['agent']);
      expect(lease.connection.facts.authKeyAlgorithm).toBe('rsa-sha2-512');
      expect(lease.connection.facts.agentForwarding).toBe('off');
      expect(io.prompts).toEqual([]);
      lease.release();
    } finally {
      agent.kill();
    }
  });

  it('forwards the agent, so the host can use the keys it holds', async () => {
    const { socket, agent } = await startAgent('id_ed25519');
    try {
      const lease = await home
        .manager({ box: ['User alice', `IdentityAgent ${socket}`, 'ForwardAgent yes'] })
        .connect(ssh('box'), recordingIo().io);
      expect(lease.connection.facts.agentForwarding).toBe('on');
      const listing = await finished(await lease.connection.transport.exec('ssh-add -l'));
      expect(listing.code).toBe(0);
      // The key's comment, as the agent on this side holds it.
      expect(listing.stdout).toContain('ed25519');
      lease.release();
    } finally {
      agent.kill();
    }
  });

  it('carries on with a password when the agent socket leads nowhere', async () => {
    const io = recordingIo([['alice-pass']]);
    const lease = await home
      .manager({ box: [...BY_PASSWORD, `IdentityAgent ${path.join(home.home, 'no-agent.sock')}`] })
      .connect(ssh('box'), io.io);
    expect(lease.connection.facts.authMethods).toEqual(['password']);
    // A stale agent socket is not worth a word to the user.
    expect(io.statuses.filter((status) => /agent/i.test(status))).toEqual([]);
    lease.release();
  });
});
