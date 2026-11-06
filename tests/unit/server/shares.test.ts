import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NfsProfile, SmbProfile } from '@muxus/shared';
import { runWithPrompts } from '../../../server/src/shares/run-with-prompts.js';
import {
  mountFailureHint,
  mountFolderName,
  nfsPlan,
  ShareUnsupportedError,
  smbPlan,
} from '../../../server/src/shares/share-commands.js';
import { ShareManager } from '../../../server/src/shares/share-manager.js';

const smb = (patch: Partial<SmbProfile> = {}): SmbProfile => ({
  kind: 'smb',
  host: 'fs01.corp',
  port: 445,
  share: 'Team Docs',
  ...patch,
});
const nfs = (patch: Partial<NfsProfile> = {}): NfsProfile => ({ kind: 'nfs', host: 'nas', export: '/srv/data', ...patch });
const options = { mountRoot: '/Users/me/Muxus Shares', folderName: 'Docs', uid: 1000 };

describe('SMB mount plans', () => {
  it('mounts with mount_smbfs on macOS, the password left to the prompt', () => {
    const plan = smbPlan('darwin', smb({ username: 'CORP\\alice' }), { host: 'fs01.corp', port: 445 }, options);
    expect(plan.mount.command).toBe('/sbin/mount_smbfs');
    expect(plan.mount.args).toEqual(['//CORP;alice@fs01.corp/Team%20Docs', '/Users/me/Muxus Shares/Docs']);
    expect(plan.mount.args.join(' ')).not.toMatch(/secret/);
    expect(plan.unmount).toEqual({ command: '/usr/sbin/diskutil', args: ['unmount', '/Users/me/Muxus Shares/Docs'] });
  });

  it('mounts as guest without waiting for a password, and through a forwarded port', () => {
    const plan = smbPlan('darwin', smb(), { host: '127.0.0.1', port: 50123 }, options);
    expect(plan.mount.args).toEqual(['-N', '//guest@127.0.0.1:50123/Team%20Docs', '/Users/me/Muxus Shares/Docs']);
  });

  it('uses gio on Linux', () => {
    const plan = smbPlan('linux', smb({ username: 'alice' }), { host: 'fs01.corp', port: 445 }, options);
    expect(plan.mount).toMatchObject({ command: 'gio', args: ['mount', 'smb://alice@fs01.corp/Team%20Docs'] });
    expect(plan.unmount.args).toEqual(['mount', '-u', 'smb://alice@fs01.corp/Team%20Docs']);
  });

  it('uses net use on Windows, as you when no user is set', () => {
    expect(smbPlan('win32', smb(), { host: 'fs01.corp', port: 445 }, options).mount.args).toEqual([
      'use',
      '\\\\fs01.corp\\Team Docs',
      '/persistent:no',
    ]);
    expect(smbPlan('win32', smb({ username: 'CORP\\alice' }), { host: 'fs01.corp', port: 445 }, options).mount.args).toEqual([
      'use',
      '\\\\fs01.corp\\Team Docs',
      '*',
      '/user:CORP\\alice',
      '/persistent:no',
    ]);
    expect(() => smbPlan('win32', smb(), { host: '127.0.0.1', port: 50123 }, options)).toThrow(ShareUnsupportedError);
  });
});

describe('NFS mount plans', () => {
  it('mounts NFSv4 with the forwarded port on macOS and Linux', () => {
    expect(nfsPlan('darwin', nfs({ readOnly: true }), { host: '127.0.0.1', port: 50124 }, options).mount).toEqual({
      command: '/sbin/mount_nfs',
      args: ['-o', 'vers=4,port=50124,ro', '127.0.0.1:/srv/data', '/Users/me/Muxus Shares/Docs'],
    });
    expect(nfsPlan('linux', nfs({ version: '3' }), { host: 'nas', port: 2049 }, options).mount).toEqual({
      command: 'mount',
      args: ['-t', 'nfs', '-o', 'nfsvers=3', 'nas:/srv/data', '/Users/me/Muxus Shares/Docs'],
    });
  });

  it('refuses NFSv3 through a gateway', () => {
    expect(() => nfsPlan('linux', nfs({ version: '3' }), { host: '127.0.0.1', port: 5000 }, options)).toThrow(/NFSv4/);
  });

  it('reads the drive letter the Windows client picked', () => {
    const plan = nfsPlan('win32', nfs(), { host: 'nas', port: 2049 }, options);
    expect(plan.mount.args).toEqual(['-o', 'anon', '\\\\nas\\srv\\data', '*']);
    expect(plan.pathFromOutput?.('Z: is now successfully connected to \\\\nas\\srv\\data')).toBe('Z:\\');
  });

  it('explains the usual failures', () => {
    expect(mountFailureHint('linux', 'nfs', 'mount: only root can do that')).toMatch(/fstab/);
    expect(mountFailureHint('linux', 'smb', 'gio: command not found')).toMatch(/gvfs/);
  });
});

describe('mount folder names', () => {
  it('keeps names readable and safe', () => {
    expect(mountFolderName('Team: Docs/2026')).toBe('Team- Docs-2026');
    expect(mountFolderName('..')).toBe('share');
  });
});

/** A stand-in mount tool: asks for a password on its terminal, like mount_smbfs. */
const PROMPTER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = () => rl.question('Password for fs01: ', (answer) => {
  if (answer === 'right') { console.log('mounted'); process.exit(0); }
  ask();
});
ask();
`;

describe('running a mount tool on a terminal', () => {
  const step = {
    command: process.execPath,
    args: ['-e', PROMPTER],
    answers: [{ prompt: /password/i, answer: 'password' as const }],
  };

  it('types the password into the prompt', async () => {
    const result = await runWithPrompts(step, { password: 'right' }, { timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('mounted');
    expect(result.output).not.toContain('right');
  }, 15_000);

  it('stops at a second prompt instead of hanging', async () => {
    const result = await runWithPrompts(step, { password: 'wrong' }, { timeoutMs: 10_000 });
    expect(result.exitCode).not.toBe(0);
    expect(result.refused).toBe('password');
  }, 15_000);

  it('reports a prompt it had no answer for', async () => {
    const result = await runWithPrompts(step, {}, { timeoutMs: 10_000 });
    expect(result.unanswered).toBe('password');
  }, 15_000);
});

describe('share manager', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function manager(run: ReturnType<typeof vi.fn>, vault?: object) {
    root = mkdtempSync(path.join(os.tmpdir(), 'muxus-shares-'));
    const stopForward = vi.fn();
    const shares = new ShareManager({
      savedShare: (id) => (id === 'docs' ? { name: 'Docs', profile: smb({ username: 'alice' }) } : undefined),
      vault: vault as never,
      stopForward,
      platform: 'darwin',
      mountRoot: root,
      run: run as never,
    });
    return { shares, stopForward };
  }

  it('asks for a password, then mounts with it', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, output: '', unanswered: 'password' })
      .mockResolvedValueOnce({ exitCode: 0, output: '' });
    const { shares } = manager(run);

    const first = await shares.mount('docs', {});
    expect(first).toMatchObject({ status: 'password-required', rejected: false, rememberable: false });

    const second = await shares.mount('docs', { password: 'pw', remember: true });
    expect(second).toMatchObject({ status: 'mounted', alreadyMounted: false });
    expect(second.status === 'mounted' && second.warning).toMatch(/password vault/);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ command: '/sbin/mount_smbfs' }), {
      password: 'pw',
      user: 'alice',
      domain: '',
    });
    expect(shares.list()).toEqual([]); // a temp folder is not a real mount point, so it is not listed as mounted
  });

  it('says when the password was rejected', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 77, output: 'mount_smbfs: server rejected the connection: Authentication error' });
    const { shares } = manager(run);
    expect(await shares.mount('docs', { password: 'bad' })).toMatchObject({ status: 'password-required', rejected: true });
  });

  it('uses the remembered password from an unlocked vault', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, output: '' });
    const vault = {
      status: () => ({ configured: true, locked: false }),
      hasSshPassword: () => true,
      sshPassword: vi.fn().mockResolvedValue('saved'),
    };
    const { shares } = manager(run, vault);
    await shares.mount('docs', {});
    expect(run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ password: 'saved' }));
  });

  it('reports a failed mount with its output', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 64, output: 'mount_smbfs: server connection failed: No route to host' });
    const { shares } = manager(run);
    await expect(shares.mount('docs', {})).rejects.toThrow(/No route to host/);
    await expect(shares.mount('gone', {})).rejects.toThrow(/no longer exists/);
  });
});
