import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildChain } from '../../../server/src/ssh/connection-manager.js';
import { loadConfigDocument } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-chain-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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
});
