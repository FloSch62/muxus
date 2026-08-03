import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FolderAuthSettings } from '@muxus/shared';
import { buildChain } from '../../../server/src/ssh/connection-manager.js';
import {
  folderAuthOptionLines,
  folderAuthResolver,
  mergeFolderAuth,
} from '../../../server/src/ssh/folder-auth.js';
import { folderPasswordAccount } from '../../../server/src/security/password-vault.js';
import { loadConfigDocument, resolveHost } from '../../../server/src/ssh/ssh-config.js';
import {
  folderChain,
  folderPathKey,
  isDescendantFolderPath,
  normalizeFolderPath,
  renameFolderPathUnder,
} from '../../../server/src/util/folder-paths.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-folder-auth-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function docOf(content: string) {
  const dir = path.join(tmp, `c-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config');
  writeFileSync(file, content);
  return loadConfigDocument(file);
}

describe('folder path helpers', () => {
  it('normalizes separators and trims segments', () => {
    expect(normalizeFolderPath(' /Prod // EU / ')).toBe('Prod/EU');
    expect(folderPathKey('Prod/EU')).toBe('prod/eu');
    expect(folderPathKey('  ')).toBe('');
  });

  it('walks the folder chain nearest first', () => {
    expect(folderChain('a/b/c')).toEqual(['a/b/c', 'a/b', 'a']);
    expect(folderChain('')).toEqual([]);
  });

  it('is segment-aware for descendants, like the client', () => {
    expect(isDescendantFolderPath('Production/EU', 'Production')).toBe(true);
    expect(isDescendantFolderPath('Production', 'Prod')).toBe(false);
    expect(isDescendantFolderPath('production/eu', 'PRODUCTION')).toBe(true);
  });

  it('rewrites paths under a renamed folder', () => {
    expect(renameFolderPathUnder('Prod', 'Prod', 'Production')).toBe('Production');
    expect(renameFolderPathUnder('Prod/EU/Edge', 'Prod', 'Production')).toBe('Production/EU/Edge');
    expect(renameFolderPathUnder('Staging', 'Prod', 'Production')).toBeUndefined();
  });
});

describe('mergeFolderAuth', () => {
  it('lets the nearest folder win per field, filling gaps from ancestors', () => {
    const merged = mergeFolderAuth([
      { port: 2222 },
      { user: 'parent', port: 22, forwardAgent: true },
    ]);
    expect(merged).toEqual({ user: 'parent', port: 2222, forwardAgent: true });
  });
});

describe('folderAuthOptionLines', () => {
  it('renders one line per set field and quotes paths with spaces', () => {
    const lines = folderAuthOptionLines({
      user: 'admin',
      port: 2222,
      identityFiles: ['/keys/my key'],
      identitiesOnly: true,
    });
    expect(lines.map((line) => [line.key, line.value])).toEqual([
      ['user', 'admin'],
      ['port', '2222'],
      ['identityfile', '"/keys/my key"'],
      ['identitiesonly', 'yes'],
    ]);
    expect(lines[2]!.args).toEqual(['/keys/my key']);
  });
});

describe('resolveHost with folder fallback', () => {
  const fallback = (auth: FolderAuthSettings) => folderAuthOptionLines(auth);

  it('fills user and port the config leaves unset', () => {
    const doc = docOf('Host web\n  HostName web.example.com');
    const resolved = resolveHost(doc, 'web', fallback({ user: 'admin', port: 2222 }));
    expect(resolved.user).toBe('admin');
    expect(resolved.port).toBe(2222);
  });

  it('never beats the host block or Host * defaults', () => {
    const doc = docOf(
      [
        'Host web',
        '  User blockuser',
        '',
        'Host *',
        '  Port 2200',
      ].join('\n'),
    );
    const resolved = resolveHost(doc, 'web', fallback({ user: 'admin', port: 9999 }));
    expect(resolved.user).toBe('blockuser');
    expect(resolved.port).toBe(2200);
  });

  it('appends the folder key after the host block keys, ssh-style', () => {
    const doc = docOf('Host web\n  IdentityFile ~/.ssh/host_key');
    const resolved = resolveHost(doc, 'web', fallback({ identityFiles: ['~/.ssh/folder_key'] }));
    expect(resolved.identityFiles.map((file) => path.basename(file))).toEqual([
      'host_key',
      'folder_key',
    ]);
  });

  it('supplies a key and IdentitiesOnly to hosts with none of their own', () => {
    const doc = docOf('Host web\n  HostName web.example.com');
    const resolved = resolveHost(
      doc,
      'web',
      fallback({ identityFiles: ['~/.ssh/folder_key'], identitiesOnly: true }),
    );
    expect(resolved.identityFiles.map((file) => path.basename(file))).toEqual(['folder_key']);
    expect(resolved.identitiesOnly).toBe(true);
  });

  it('passes an agent socket path containing spaces through intact', () => {
    const doc = docOf('Host web\n  HostName web.example.com');
    const resolved = resolveHost(
      doc,
      'web',
      fallback({ identityAgent: '/tmp/agent dir/agent.sock' }),
    );
    expect(resolved.identityAgent).toBe('/tmp/agent dir/agent.sock');
  });
});

describe('buildChain with folder defaults', () => {
  it('applies each hop its own folder, and passwords ride on the hop', () => {
    const doc = docOf(
      [
        'Host app',
        '  HostName app.internal',
        '  ProxyJump bastion',
        '',
        'Host bastion',
        '  HostName bastion.example.com',
      ].join('\n'),
    );
    const perAlias: Record<string, FolderAuthSettings> = {
      app: { user: 'appuser' },
      bastion: { user: 'jumpuser', port: 2200 },
    };
    const chain = buildChain(doc, { target: 'app' }, (alias) => {
      const auth = perAlias[alias];
      if (!auth) return undefined;
      return {
        optionLines: folderAuthOptionLines(auth),
        passwords: [{ account: `acct-${alias}`, label: `Folder ${alias}` }],
      };
    });
    expect(chain[0]).toMatchObject({ user: 'jumpuser', port: 2200 });
    expect(chain[1]).toMatchObject({ user: 'appuser', port: 22 });
    expect(chain[1]!.folderPasswords).toEqual([
      { account: 'acct-app', label: 'Folder app' },
    ]);
  });

  it('keeps per-connection overrides above folder defaults', () => {
    const doc = docOf('Host web\n  HostName web.example.com');
    const chain = buildChain(doc, { target: 'web', user: 'override' }, () => ({
      optionLines: folderAuthOptionLines({ user: 'folderuser' }),
      passwords: [],
    }));
    expect(chain[0]!.user).toBe('override');
  });

  it('ignores folder defaults for self-contained (useConfig: false) dials', () => {
    const doc = docOf('Host web\n  HostName web.example.com');
    const chain = buildChain(doc, { target: 'web', useConfig: false }, () => ({
      optionLines: folderAuthOptionLines({ user: 'folderuser', port: 2222 }),
      passwords: [{ account: 'acct', label: 'Folder' }],
    }));
    expect(chain[0]!.user).not.toBe('folderuser');
    expect(chain[0]!.port).toBe(22);
    expect(chain[0]!.folderPasswords).toBeUndefined();
  });
});

describe('folderAuthResolver', () => {
  const settings = new Map<string, { id: string; path: string; auth: FolderAuthSettings }>([
    ['prod', { id: 'row-prod', path: 'Prod', auth: { user: 'root', port: 2200 } }],
    ['prod/eu', { id: 'row-eu', path: 'Prod/EU', auth: { port: 2222 } }],
  ]);
  const resolver = folderAuthResolver({
    groupForAlias: (alias) => (alias === 'web' ? 'Prod/EU' : undefined),
    folderSettingsForPath: (path) => settings.get(folderPathKey(path)),
  });

  it('collapses the ancestor chain nearest-first and lists all passwords', () => {
    const defaults = resolver('web');
    expect(defaults).toBeDefined();
    const byKey = Object.fromEntries(defaults!.optionLines.map((line) => [line.key, line.args[0]]));
    expect(byKey).toEqual({ user: 'root', port: '2222' });
    expect(defaults!.passwords).toEqual([
      { account: folderPasswordAccount('row-eu'), label: 'Folder Prod/EU' },
      { account: folderPasswordAccount('row-prod'), label: 'Folder Prod' },
    ]);
  });

  it('returns nothing for hosts outside folders or folders without settings', () => {
    expect(resolver('bare')).toBeUndefined();
    const empty = folderAuthResolver({
      groupForAlias: () => 'Unrelated',
      folderSettingsForPath: () => undefined,
    });
    expect(empty('web')).toBeUndefined();
  });
});
