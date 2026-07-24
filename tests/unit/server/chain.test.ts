import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildChain,
  expandProxyCommand,
  findMetadataAlias,
  observeSshTransportHealth,
  terminalPtyOptions,
} from '../../../server/src/ssh/connection-manager.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-chain-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

let counter = 0;
function docOf(content: string) {
  const dir = path.join(tmp, `c-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config');
  writeFileSync(file, content);
  return loadConfigDocument(file);
}

describe('buildChain', () => {
  it('is a single hop without ProxyJump', () => {
    const doc = docOf(['Host web', '  HostName web.example.com', '  User deploy', '  Port 2222'].join('\n'));
    const chain = buildChain(doc, { target: 'web' });
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ user: 'deploy', port: 2222, hopLabel: undefined });
    expect(chain[0]!.resolved.hostname).toBe('web.example.com');
  });

  it('dials jump hops first, resolving each through the config', () => {
    const doc = docOf(
      [
        'Host app',
        '  HostName app.internal',
        '  ProxyJump bastion',
        '',
        'Host bastion',
        '  HostName bastion.example.com',
        '  User jumpuser',
        '  Port 2200',
      ].join('\n'),
    );
    const chain = buildChain(doc, { target: 'app' });
    expect(chain.map((h) => h.resolved.hostname)).toEqual(['bastion.example.com', 'app.internal']);
    expect(chain[0]).toMatchObject({ user: 'jumpuser', port: 2200, hopLabel: 'bastion' });
    expect(chain[1]!.hopLabel).toBeUndefined();
  });

  it('expands nested and comma-listed jumps in dial order', () => {
    const doc = docOf(
      ['Host app', '  ProxyJump j1,ops@j2:2202', '', 'Host j1', '  HostName j1.example.com', '  ProxyJump j0', '', 'Host j0', '  HostName j0.example.com'].join(
        '\n',
      ),
    );
    const chain = buildChain(doc, { target: 'app' });
    expect(chain.map((h) => h.spec.host)).toEqual(['j0', 'j1', 'j2', 'app']);
    expect(chain[2]).toMatchObject({ user: 'ops', port: 2202 });
  });

  it('applies profile user/port overrides to the final target only', () => {
    const doc = docOf(['Host app', '  User configured', '  ProxyJump bastion', '', 'Host bastion', '  User jumpuser'].join('\n'));
    const chain = buildChain(doc, { target: 'app', user: 'override', port: 2022 });
    expect(chain[0]!.user).toBe('jumpuser');
    expect(chain[1]).toMatchObject({ user: 'override', port: 2022 });
  });

  it('uses a self-contained final profile while resolving configured jumps', () => {
    const doc = docOf(
      [
        'Host app.internal',
        '  HostName wrong.example.com',
        '  User wrong-user',
        '  IdentityFile ~/.ssh/wrong',
        '  ProxyJump wrong-hop',
        '',
        'Host bastion',
        '  HostName bastion.example.com',
        '  User jumpuser',
      ].join('\n'),
    );
    const chain = buildChain(doc, {
      target: 'app.internal',
      useConfig: false,
      user: 'deploy',
      port: 2222,
      identityFiles: ['~/.ssh/tunnel_ed25519'],
      identitiesOnly: true,
      proxyJump: ['bastion'],
    });

    expect(chain.map((hop) => hop.resolved.hostname)).toEqual([
      'bastion.example.com',
      'app.internal',
    ]);
    expect(chain[0]).toMatchObject({ user: 'jumpuser', port: 22 });
    expect(chain[1]).toMatchObject({ user: 'deploy', port: 2222 });
    expect(chain[1]!.resolved).toMatchObject({
      identitiesOnly: true,
      proxyJump: ['bastion'],
    });
    expect(chain[1]!.resolved.identityFiles[0]).toMatch(
      /[\\/]\.ssh[\\/]tunnel_ed25519$/,
    );
  });

  it('parses ad-hoc user@host:port targets', () => {
    const doc = docOf('');
    const chain = buildChain(doc, { target: 'root@203.0.113.7:2222' });
    expect(chain[0]).toMatchObject({ user: 'root', port: 2222 });
    expect(chain[0]!.resolved.hostname).toBe('203.0.113.7');
  });

  it('detects ProxyJump cycles', () => {
    const doc = docOf(['Host a', '  ProxyJump b', '', 'Host b', '  ProxyJump a'].join('\n'));
    expect(() => buildChain(doc, { target: 'a' })).toThrowError(/cycle/);
  });

  it('keeps ProxyCommand on a direct target and lets a profile jump override it', () => {
    const doc = docOf(
      [
        'Host app',
        '  HostName app.internal',
        '  ProxyCommand tunnel %h %p',
        '',
        'Host bastion',
        '  HostName bastion.example.com',
      ].join('\n'),
    );
    expect(buildChain(doc, { target: 'app' })[0]!.resolved.proxyCommand).toBe(
      'tunnel %h %p',
    );
    const jumped = buildChain(doc, { target: 'app', proxyJump: ['bastion'] });
    expect(jumped.map((hop) => hop.spec.host)).toEqual(['bastion', 'app']);
    expect(jumped[1]!.resolved.proxyCommand).toBeUndefined();
  });
});

describe('ProxyCommand expansion', () => {
  it('expands OpenSSH destination tokens at dial time', () => {
    expect(
      expandProxyCommand('proxy %% %h %n %p %r %x', {
        hostname: 'real.internal',
        originalHost: 'alias',
        port: 2222,
        user: 'deploy',
      }),
    ).toBe('proxy % real.internal alias 2222 deploy %x');
  });
});

describe('findMetadataAlias', () => {
  it('only attributes recent-use metadata to concrete OpenSSH aliases', () => {
    const doc = docOf([
      'Host production prod',
      '  HostName 203.0.113.10',
      '',
      'Host *.internal',
      '  User deploy',
    ].join('\n'));

    expect(findMetadataAlias(doc, 'production')).toBe('production');
    expect(findMetadataAlias(doc, 'prod')).toBe('prod');
    expect(findMetadataAlias(doc, 'web.internal')).toBeUndefined();
    expect(findMetadataAlias(doc, '203.0.113.11')).toBeUndefined();
  });
});

describe('terminalPtyOptions', () => {
  it('negotiates DEL as the remote erase character to match xterm Backspace', () => {
    expect(terminalPtyOptions(132, 42, 'xterm-256color')).toEqual({
      cols: 132,
      rows: 42,
      term: 'xterm-256color',
      modes: { VERASE: 0x7f },
    });
  });
});

describe('passive SSH transport health', () => {
  it('turns suspect after two silent keepalive intervals and recovers on input', () => {
    vi.useFakeTimers();
    const transport = new PassThrough();
    const states: string[] = [];
    const stop = observeSshTransportHealth(transport, 15_000, (state) => states.push(state));

    vi.advanceTimersByTime(29_999);
    expect(states).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(states).toEqual(['suspect']);

    transport.write('keepalive reply');
    expect(states).toEqual(['suspect', 'healthy']);

    stop();
    vi.advanceTimersByTime(30_000);
    expect(states).toEqual(['suspect', 'healthy']);
    transport.destroy();
  });

  it('does not monitor when SSH keepalives are disabled', () => {
    vi.useFakeTimers();
    const transport = new PassThrough();
    const listener = vi.fn();
    observeSshTransportHealth(transport, 0, listener);
    vi.advanceTimersByTime(120_000);
    expect(listener).not.toHaveBeenCalled();
    transport.destroy();
  });
});
