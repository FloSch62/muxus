import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  hostPatternsMatch,
  listHosts,
  loadConfigDocument,
  parseHostSpec,
  parseProxyJumpList,
  resolveHost,
} from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-sshconf-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function write(content: string, name?: string): string {
  const file = path.join(tmp, name ?? `config-${counter++}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function hostsOf(content: string) {
  return listHosts(loadConfigDocument(write(content)));
}

describe('listHosts', () => {
  it('lists concrete hosts with block options and resolved settings', () => {
    const hosts = hostsOf(
      ['# Production web server', '# behind the LB', 'Host web', '  HostName web.example.com', '  User deploy', '  Port 2222'].join('\n'),
    );
    expect(hosts).toHaveLength(1);
    const web = hosts[0]!;
    expect(web.alias).toBe('web');
    expect(web.description).toBe('Production web server\nbehind the LB');
    expect(web.options).toMatchObject({ hostname: 'web.example.com', user: 'deploy', port: 2222 });
    expect(web.resolved).toMatchObject({ hostname: 'web.example.com', user: 'deploy', port: 2222, proxyJump: [], forwards: [] });
  });

  it('keeps multi-alias blocks as one entry and skips wildcard patterns', () => {
    const hosts = hostsOf(['Host db db.example.com backup-*', '  User admin', '', 'Host *', '  Port 2200'].join('\n'));
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.alias).toBe('db');
    expect(hosts[0]!.aliases).toEqual(['db', 'db.example.com']);
    expect(hosts[0]!.resolved.port).toBe(2200); // Host * default applied
    expect(hosts[0]!.options.port).toBeUndefined(); // …but not written in the block
  });

  it('collects unmodeled options into extras, order-preserved', () => {
    const hosts = hostsOf(['Host a', '  Compression yes', '  HostName a.example.com', '  ServerAliveCountMax 5'].join('\n'));
    expect(hosts[0]!.options.extras).toEqual([
      { keyword: 'Compression', value: 'yes' },
      { keyword: 'ServerAliveCountMax', value: '5' },
    ]);
  });

  it('parses forwards, proxy jumps and auth options', () => {
    const hosts = hostsOf(
      [
        'Host app',
        '  ProxyJump bastion,ops@edge:2200',
        '  IdentityFile ~/.ssh/app_key',
        '  CertificateFile ~/.ssh/app_key-cert.pub',
        '  IdentitiesOnly yes',
        '  ForwardAgent yes',
        '  LocalForward 8080 localhost:80',
        '  LocalForward 127.0.0.1:8443 [::1]:443',
        '  RemoteForward 9000 127.0.0.1:3000',
        '  DynamicForward 1080',
      ].join('\n'),
    );
    const app = hosts[0]!;
    expect(app.options.proxyJump).toEqual(['bastion', 'ops@edge:2200']);
    expect(app.options.identityFiles).toEqual(['~/.ssh/app_key']);
    expect(app.options.certificateFiles).toEqual(['~/.ssh/app_key-cert.pub']);
    expect(app.options.identitiesOnly).toBe(true);
    expect(app.options.forwardAgent).toBe(true);
    expect(app.options.forwards).toEqual([
      { type: 'local', bindPort: 8080, targetHost: 'localhost', targetPort: 80 },
      { type: 'local', bindPort: 8443, targetHost: '::1', targetPort: 443 },
      { type: 'remote', bindPort: 9000, targetHost: '127.0.0.1', targetPort: 3000 },
      { type: 'dynamic', bindPort: 1080 },
    ]);
    expect(app.resolved.identityFiles).toEqual([path.join(os.homedir(), '.ssh', 'app_key')]);
    expect(app.resolved.certificateFiles).toEqual([
      path.join(os.homedir(), '.ssh', 'app_key-cert.pub'),
    ]);
  });

  it('models ProxyCommand as a first-class block option', () => {
    const hosts = hostsOf(
      ['Host cloud', '  ProxyCommand cloudflared access ssh --hostname %h'].join('\n'),
    );
    expect(hosts[0]!.options.proxyCommand).toBe(
      'cloudflared access ssh --hostname %h',
    );
    expect(hosts[0]!.options.extras).toBeUndefined();
  });

  it('maps PubkeyAuthentication no to passwordOnly', () => {
    const hosts = hostsOf(['Host legacy', '  PubkeyAuthentication no', '  PreferredAuthentications keyboard-interactive,password'].join('\n'));
    expect(hosts[0]!.options.passwordOnly).toBe(true);
    expect(hosts[0]!.options.extras).toBeUndefined();
    expect(hosts[0]!.resolved.passwordOnly).toBe(true);
  });
});

describe('resolveHost', () => {
  it('applies first-obtained-wins across matching blocks and globals', () => {
    const doc = loadConfigDocument(
      write(
        ['User global-user', '', 'Host web', '  Port 2222', '', 'Host web', '  Port 9999', '  HostName real.example.com', '', 'Host *', '  User star-user'].join(
          '\n',
        ),
      ),
    );
    const r = resolveHost(doc, 'web');
    expect(r.user).toBe('global-user'); // top-level option read first
    expect(r.port).toBe(2222); // first block wins
    expect(r.hostname).toBe('real.example.com'); // first obtained anywhere
  });

  it('accumulates IdentityFile across blocks and dedupes', () => {
    const doc = loadConfigDocument(write(['Host web', '  IdentityFile /a', '', 'Host *', '  IdentityFile /b', '  IdentityFile /a'].join('\n')));
    expect(resolveHost(doc, 'web').identityFiles).toEqual(['/a', '/b']);
  });

  it('accumulates CertificateFile and resolves ProxyCommand', () => {
    const doc = loadConfigDocument(
      write(
        [
          'Host web',
          '  CertificateFile ~/.ssh/web-cert.pub',
          '  ProxyCommand connect-proxy %h %p',
          '',
          'Host *',
          '  CertificateFile /shared-cert.pub',
          '  CertificateFile ~/.ssh/web-cert.pub',
          '  ProxyJump ignored-because-proxy-command-won',
        ].join('\n'),
      ),
    );
    const resolved = resolveHost(doc, 'web');
    expect(resolved.certificateFiles).toEqual([
      path.join(os.homedir(), '.ssh', 'web-cert.pub'),
      '/shared-cert.pub',
    ]);
    expect(resolved.proxyCommand).toBe('connect-proxy %h %p');
    expect(resolved.proxyJump).toEqual([]);
  });

  it('lets ProxyJump win when it is obtained before ProxyCommand', () => {
    const doc = loadConfigDocument(
      write(
        [
          'Host web',
          '  ProxyJump bastion',
          '',
          'Host *',
          '  ProxyCommand ignored %h %p',
        ].join('\n'),
      ),
    );
    const resolved = resolveHost(doc, 'web');
    expect(resolved.proxyJump).toEqual(['bastion']);
    expect(resolved.proxyCommand).toBeUndefined();
  });

  it('expands %h in HostName and defaults hostname to the alias', () => {
    const doc = loadConfigDocument(write(['Host node-1 node-2', '  HostName %h.cluster.internal'].join('\n')));
    expect(resolveHost(doc, 'node-2').hostname).toBe('node-2.cluster.internal');
    expect(resolveHost(doc, 'unknown').hostname).toBe('unknown');
  });

  it('honors negated patterns', () => {
    const doc = loadConfigDocument(write(['Host prod-* !prod-3', '  User produser'].join('\n')));
    expect(resolveHost(doc, 'prod-1').user).toBe('produser');
    expect(resolveHost(doc, 'prod-3').user).toBeUndefined();
  });

  it('skips Match blocks and picks up options after them', () => {
    const doc = loadConfigDocument(
      write(['Host web', '  Port 2222', '', 'Match host web', '  User matched', '', 'Host web2', '  User plain'].join('\n')),
    );
    expect(resolveHost(doc, 'web').user).toBeUndefined();
    expect(resolveHost(doc, 'web2').user).toBe('plain');
  });

  it('reads ConnectTimeout and ServerAliveInterval', () => {
    const doc = loadConfigDocument(write(['Host slow', '  ConnectTimeout 45', '  ServerAliveInterval 30'].join('\n')));
    const r = resolveHost(doc, 'slow');
    expect(r.connectTimeout).toBe(45);
    expect(r.serverAliveInterval).toBe(30);
  });

  it('follows Include files with evaluation order intact', () => {
    const inc = write(['Host from-include', '  User inc'].join('\n'), 'conf.d/extra');
    const doc = loadConfigDocument(write([`Include ${inc}`, '', 'Host base', '  User base'].join('\n')));
    expect(listHosts(doc).map((h) => h.alias).sort()).toEqual(['base', 'from-include']);
    expect(doc.fileOrder).toHaveLength(2);
  });

  it('records an error for unreadable includes but keeps parsing', () => {
    const doc = loadConfigDocument(write([`Include ${path.join(tmp, 'nope', 'missing')}`, 'Host still-here'].join('\n')));
    expect(doc.error).toMatch(/could not read/);
    expect(listHosts(doc).map((h) => h.alias)).toEqual(['still-here']);
  });
});

describe('pattern + spec helpers', () => {
  it('matches ssh glob patterns', () => {
    expect(hostPatternsMatch(['*.example.com'], 'a.example.com')).toBe(true);
    expect(hostPatternsMatch(['prod-?'], 'prod-1')).toBe(true);
    expect(hostPatternsMatch(['prod-?'], 'prod-12')).toBe(false);
    expect(hostPatternsMatch(['*', '!secret'], 'secret')).toBe(false);
  });

  it('parses host specs', () => {
    expect(parseHostSpec('web')).toEqual({ host: 'web', user: undefined });
    expect(parseHostSpec('root@web')).toEqual({ host: 'web', user: 'root' });
    expect(parseHostSpec('root@web:2222')).toEqual({ host: 'web', user: 'root', port: 2222 });
    expect(parseHostSpec('[::1]:2200')).toEqual({ host: '::1', user: undefined, port: 2200 });
  });

  it('parses ProxyJump lists', () => {
    expect(parseProxyJumpList('a, b@c:22 ,d')).toEqual(['a', 'b@c:22', 'd']);
    expect(parseProxyJumpList('none')).toEqual([]);
    expect(parseProxyJumpList(undefined)).toEqual([]);
  });
});
