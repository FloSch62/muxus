import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { HostUpsertRequest } from '@muxus/shared';
import { deleteHost, previewHost, upsertHost } from '../../../server/src/ssh/ssh-config-edit.js';
import { listHosts, loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-sshedit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;

/** Path for a config whose .ssh directory does not exist yet. */
function freshRoot(): string {
  return path.join(tmp, `home-${counter++}`, '.ssh', 'config');
}

function seed(content: string): string {
  const dir = path.join(tmp, `home-${counter++}`, '.ssh');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config');
  writeFileSync(file, content);
  return file;
}

const req = (over: Partial<HostUpsertRequest> = {}): HostUpsertRequest => ({
  aliases: ['web'],
  options: { hostname: 'web.example.com', user: 'deploy', port: 2222 },
  ...over,
});

describe('upsertHost', () => {
  it('creates the config (0600) when none exists', () => {
    const root = freshRoot();
    upsertHost(req({ description: 'Main web box' }), root);
    const text = readFileSync(root, 'utf8');
    expect(text).toBe(['# Main web box', 'Host web', '  HostName web.example.com', '  User deploy', '  Port 2222', ''].join('\n'));
    if (process.platform !== 'win32') expect(statSync(root).mode & 0o777).toBe(0o600);
  });

  it('appends after existing content with a blank separator, untouched bytes elsewhere', () => {
    const existing = ['# hand-written banner', 'Host *', '\tServerAliveInterval 60', '', 'Host db', '\tHostName db.internal'].join('\n');
    const root = seed(`${existing}\n`);
    upsertHost(req(), root);
    const text = readFileSync(root, 'utf8');
    expect(text.startsWith(`${existing}\n`)).toBe(true);
    // Indentation style of the file (tabs) is picked up for the new block.
    expect(text).toContain('\tHostName web.example.com');
  });

  it('edits a block in place, leaving neighbors byte-identical', () => {
    const root = seed(
      ['# before', 'Host a', '  User alpha', '', '# web comment', 'Host web', '  HostName old.example.com', '', 'Host z', '  User zed', ''].join('\n'),
    );
    upsertHost(req({ previousAlias: 'web', description: 'web comment' }), root);
    const text = readFileSync(root, 'utf8');
    expect(text).toBe(
      [
        '# before',
        'Host a',
        '  User alpha',
        '',
        '# web comment',
        'Host web',
        '  HostName web.example.com',
        '  User deploy',
        '  Port 2222',
        '',
        'Host z',
        '  User zed',
        '',
      ].join('\n'),
    );
  });

  it('renames an alias and preserves wildcard co-patterns on the Host line', () => {
    const root = seed(['Host web w-*', '  HostName web.example.com', ''].join('\n'));
    upsertHost(req({ aliases: ['website'], previousAlias: 'web' }), root);
    const text = readFileSync(root, 'utf8');
    expect(text).toContain('Host website w-*');
    expect(listHosts(loadConfigDocument(root))[0]!.alias).toBe('website');
  });

  it('rejects an alias that already exists in another block', () => {
    const root = seed(['Host web', '  User a', '', 'Host db', '  User b', ''].join('\n'));
    expect(() => upsertHost(req({ aliases: ['db'], previousAlias: 'web' }), root)).toThrowError(/already exists/);
    expect(() => upsertHost(req({ aliases: ['web'] }), root)).toThrowError(/already exists/);
  });

  it('round-trips a listed host without semantic drift', () => {
    const root = seed(
      [
        '# my app',
        'Host app',
        '  HostName app.example.com',
        '  ProxyJump bastion',
        '  IdentityFile ~/.ssh/app',
        '  CertificateFile ~/.ssh/app-cert.pub',
        '  IdentityAgent ${ONEPASSWORD_SSH_AUTH_SOCK}',
        '  ProxyCommand custom-proxy %h %p',
        '  LocalForward 8080 localhost:80',
        '  StrictHostKeyChecking accept-new',
        '  RemoteCommand tmux new -A -s main',
        '  RequestTTY yes',
        '  Compression yes',
        '',
      ].join('\n'),
    );
    const before = listHosts(loadConfigDocument(root))[0]!;
    upsertHost({ aliases: before.aliases, description: before.description, options: before.options, previousAlias: before.alias }, root);
    const after = listHosts(loadConfigDocument(root))[0]!;
    expect(after).toEqual(before);
  });

  it('moves a host to a new include file and wires the Include into the root', () => {
    const root = seed(['Host web', '  HostName web.example.com', '', 'Host db', '  User b', ''].join('\n'));
    const groupFile = path.join(path.dirname(root), 'config.d', 'work');
    upsertHost(req({ previousAlias: 'web', file: groupFile }), root);
    const rootText = readFileSync(root, 'utf8');
    expect(rootText).not.toContain('web.example.com');
    expect(rootText).toContain(`Include ${path.join('config.d', 'work')}`);
    expect(readFileSync(groupFile, 'utf8')).toContain('HostName web.example.com');
    const hosts = listHosts(loadConfigDocument(root));
    expect(hosts.map((h) => h.alias).sort()).toEqual(['db', 'web']);
    expect(hosts.find((h) => h.alias === 'web')!.file).toBe(groupFile);
  });

  it('refuses config files outside the root config directory', () => {
    const root = seed('');
    expect(() => upsertHost(req({ file: '/etc/passwd' }), root)).toThrowError(/must live under/);
  });

  it('validates aliases and extras', () => {
    const root = seed('');
    expect(() => upsertHost(req({ aliases: ['has space'] }), root)).toThrowError(/invalid alias/);
    expect(() => upsertHost(req({ aliases: ['star*'] }), root)).toThrowError(/invalid alias/);
    expect(() => upsertHost(req({ options: { extras: [{ keyword: 'Host', value: 'x' }] } }), root)).toThrowError(/invalid option keyword/);
    expect(() => upsertHost(req({ options: { extras: [{ keyword: 'Weird Key', value: 'x' }] } }), root)).toThrowError(/invalid option keyword/);
    expect(() =>
      upsertHost(
        req({
          options: {
            proxyJump: ['bastion'],
            proxyCommand: 'proxy %h %p',
          },
        }),
        root,
      ),
    ).toThrowError(/mutually exclusive/);
  });

  it('keeps a .muxus.bak of the previous content', () => {
    const root = seed(['Host web', '  User old', ''].join('\n'));
    upsertHost(req({ previousAlias: 'web' }), root);
    expect(readFileSync(`${root}.muxus.bak`, 'utf8')).toContain('User old');
  });

  it.skipIf(process.platform === 'win32')('preserves a config symlink and atomically replaces its target', () => {
    const home = path.join(tmp, `home-${counter++}`);
    const sshDir = path.join(home, '.ssh');
    const targetDir = path.join(home, 'dotfiles');
    const target = path.join(targetDir, 'ssh-config');
    const root = path.join(sshDir, 'config');
    mkdirSync(sshDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, ['Host web', '  User old', ''].join('\n'));
    symlinkSync(path.relative(sshDir, target), root);

    upsertHost(req({ previousAlias: 'web' }), root);

    expect(lstatSync(root).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('HostName web.example.com');
    expect(readFileSync(`${root}.muxus.bak`, 'utf8')).toContain('User old');
  });
});

describe('deleteHost', () => {
  it('removes the block including its prelude comment, collapsing blanks', () => {
    const root = seed(['Host a', '  User alpha', '', '# doomed', 'Host web', '  HostName web.example.com', '', 'Host z', '  User zed', ''].join('\n'));
    deleteHost('web', root);
    expect(readFileSync(root, 'utf8')).toBe(['Host a', '  User alpha', '', 'Host z', '  User zed', ''].join('\n'));
  });

  it('404s for unknown aliases', () => {
    const root = seed('Host a\n  User alpha\n');
    expect(() => deleteHost('nope', root)).toThrowError(/no Host block/);
  });
});

describe('previewHost', () => {
  it('renders exactly what upsert would write', () => {
    const root = seed('');
    const text = previewHost(req({ description: 'Web box' }), root);
    expect(text).toBe(['# Web box', 'Host web', '  HostName web.example.com', '  User deploy', '  Port 2222'].join('\n'));
    expect(existsSync(`${root}.muxus.tmp`)).toBe(false);
  });

  it('renders modeled authentication, security, and startup options', () => {
    const root = seed('');
    const text = previewHost(
      req({
        options: {
          identityFiles: ['~/.ssh/app'],
          identitiesOnly: true,
          certificateFiles: ['~/.ssh/app-cert.pub'],
          identityAgent: '${ONEPASSWORD_SSH_AUTH_SOCK}',
          proxyCommand: 'cloudflared access ssh --hostname %h',
          strictHostKeyChecking: 'accept-new',
          remoteCommand: 'tmux new -A -s main',
          requestTty: 'yes',
        },
      }),
      root,
    );
    expect(text).toContain('  IdentityFile ~/.ssh/app');
    expect(text).toContain('  IdentitiesOnly yes');
    expect(text).toContain('  CertificateFile ~/.ssh/app-cert.pub');
    expect(text).toContain('  IdentityAgent ${ONEPASSWORD_SSH_AUTH_SOCK}');
    expect(text).toContain('  ProxyCommand cloudflared access ssh --hostname %h');
    expect(text).toContain('  StrictHostKeyChecking accept-new');
    expect(text).toContain('  RemoteCommand tmux new -A -s main');
    expect(text).toContain('  RequestTTY yes');
  });

  it('double-quotes paths containing whitespace or apostrophes', () => {
    const root = seed('');
    const windowsKey = String.raw`C:\Users\toweber\OneDrive - Nokia\SSH Key\toweber`;
    const apostropheKey = String.raw`C:\Users\O'Neil\.ssh\id_ed25519`;
    const request = req({
      options: { user: "O'Neil", identityFiles: [windowsKey, apostropheKey] },
    });
    const text = previewHost(request, root);
    expect(text).toContain('  User "O\'Neil"');
    expect(text).toContain(`  IdentityFile "${windowsKey}"`);
    expect(text).toContain(`  IdentityFile "${apostropheKey}"`);

    upsertHost(request, root);
    const host = listHosts(loadConfigDocument(root))[0]!;
    expect(host.options.user).toBe("O'Neil");
    expect(host.resolved.user).toBe("O'Neil");
    expect(host.options.identityFiles).toEqual([windowsKey, apostropheKey]);
  });
});
