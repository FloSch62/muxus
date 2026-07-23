import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseSshConfigHosts } from '../../../server/src/ssh/ssh-config.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-sshconf-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const file = path.join(tmp, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe('parseSshConfigHosts', () => {
  it('collects concrete Host aliases with their hints', () => {
    const file = write(
      'basic',
      ['Host web', '  HostName web.example.com', '  User deploy', '  Port 2222', '', 'Host db bastion', '  User admin'].join('\n'),
    );
    const { hosts } = parseSshConfigHosts(file);
    expect(hosts).toEqual([
      { alias: 'web', hostname: 'web.example.com', user: 'deploy', port: 2222 },
      { alias: 'db', user: 'admin' },
      { alias: 'bastion', user: 'admin' },
    ]);
  });

  it('skips wildcard and negated patterns', () => {
    const file = write('wild', ['Host *', '  User root', 'Host prod-? !prod-3', 'Host real', '  HostName r.example.com'].join('\n'));
    const { hosts } = parseSshConfigHosts(file);
    expect(hosts.map((h) => h.alias)).toEqual(['real']);
  });

  it('honors first-obtained-value-wins like ssh', () => {
    const file = write('firstwins', ['Host a', '  User first', '  User second', 'Host a', '  Port 22'].join('\n'));
    const { hosts } = parseSshConfigHosts(file);
    expect(hosts).toEqual([{ alias: 'a', user: 'first', port: 22 }]);
  });

  it('ignores Match blocks', () => {
    const file = write('match', ['Host ok', 'Match host *.internal', '  User nope', 'Host ok2'].join('\n'));
    const { hosts } = parseSshConfigHosts(file);
    expect(hosts.map((h) => h.alias)).toEqual(['ok', 'ok2']);
    expect(hosts[0]?.user).toBeUndefined();
  });

  it('supports Keyword=value and quoted arguments', () => {
    const file = write('quoted', ['Host "my host"', '  HostName=quoted.example.com'].join('\n'));
    const { hosts } = parseSshConfigHosts(file);
    expect(hosts).toEqual([{ alias: 'my host', hostname: 'quoted.example.com' }]);
  });

  it('follows Include with globs', () => {
    write('conf.d/one', 'Host included-one\n');
    write('conf.d/two', 'Host included-two\n');
    const file = write('withinclude', [`Include ${tmp}/conf.d/*`, 'Host main'].join('\n'));
    const { hosts } = parseSshConfigHosts(file);
    expect(hosts.map((h) => h.alias).sort()).toEqual(['included-one', 'included-two', 'main']);
  });

  it('reports unreadable includes without dying', () => {
    const file = write('badinclude', [`Include ${tmp}/does-not-exist-dir/nope`, 'Host still-here'].join('\n'));
    const { hosts, error } = parseSshConfigHosts(file);
    expect(hosts.map((h) => h.alias)).toEqual(['still-here']);
    expect(error).toContain('could not read included file');
  });

  it('returns empty for a missing root config', () => {
    const { hosts, error } = parseSshConfigHosts(path.join(tmp, 'missing'));
    expect(hosts).toEqual([]);
    expect(error).toBeUndefined();
  });
});
