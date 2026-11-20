import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BitwardenProvider } from '../../../server/src/password-managers/bitwarden.js';
import { runCli } from '../../../server/src/password-managers/cli.js';
import { DashlaneProvider } from '../../../server/src/password-managers/dashlane.js';
import { LastPassProvider } from '../../../server/src/password-managers/lastpass.js';
import { OnePasswordProvider } from '../../../server/src/password-managers/onepassword.js';
import { PassProvider } from '../../../server/src/password-managers/pass.js';
import { ProtonPassProvider } from '../../../server/src/password-managers/protonpass.js';
import { PasswordManagerError } from '../../../server/src/password-managers/provider.js';

// The stand-in programs are shell-launched Node scripts.
const posix = process.platform !== 'win32';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'muxus-password-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * A program that behaves as `body` says. `args` are its arguments, `log` the
 * file every invocation is appended to, and `out`/`fail` end the run.
 */
function fakeProgram(name: string, body: string): { program: string; calls: () => string[][] } {
  const program = path.join(tmp, name);
  const log = `${program}.log`;
  writeFileSync(
    program,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const out = (text) => { process.stdout.write(text); process.exit(0); };
const fail = (text, code = 1) => { process.stderr.write(text + '\\n'); process.exit(code); };
const has = (...words) => words.every((word) => args.includes(word));
${body}
fail('unexpected arguments: ' + args.join(' '), 64);
`,
  );
  chmodSync(program, 0o755);
  return {
    program,
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}

async function problemOf(action: Promise<unknown>): Promise<string | undefined> {
  try {
    await action;
    return undefined;
  } catch (err) {
    return err instanceof PasswordManagerError ? err.problem : `unexpected: ${String(err)}`;
  }
}

describe.runIf(posix)('running a password manager program', () => {
  it('reports a missing program, and kills one that never answers', async () => {
    expect(await problemOf(runCli(path.join(tmp, 'not-installed'), ['x']))).toBe('unavailable');
    const { program } = fakeProgram('hangs', 'setTimeout(() => {}, 60_000); return;');
    expect(await problemOf(runCli(program, [], { timeoutMs: 300 }))).toBe('timeout');
  });
});

describe.runIf(posix)('1Password', () => {
  const { program, calls } = fakeProgram(
    'op',
    `
if (has('account', 'list')) out(JSON.stringify([{ url: 'my.1password.com', email: 'me@example.com' }]));
if (has('item', 'list')) out(JSON.stringify([
  { id: 'itemaaaa', title: 'Core router', category: 'LOGIN', vault: { id: 'vaultxyz', name: 'Network' },
    additional_information: 'admin', urls: [{ href: 'https://other' }, { primary: true, href: 'ssh://core1' }] },
  { id: 'itembbbb', title: 'Wifi', category: 'PASSWORD', vault: { id: 'vaultxyz', name: 'Network' }, additional_information: '—' },
]));
if (args[0] === 'read' && args.includes('op://vaultxyz/itemaaaa/password')) out('s3cret with spaces ');
if (args[0] === 'read') fail('[ERROR] 2026/01/02 03:04:05 "itemzzzz" isn\\'t an item in the "vaultxyz" vault');
`,
  );

  it('lists items and reads a password by vault and item ID', async () => {
    const provider = new OnePasswordProvider({ program, account: 'my.1password.com' });
    expect(await provider.status()).toEqual({ state: 'ready' });
    expect(await provider.entries()).toEqual([
      { id: 'vaultxyz/itemaaaa', title: 'Core router', username: 'admin', url: 'ssh://core1', group: 'Network' },
      { id: 'vaultxyz/itembbbb', title: 'Wifi', group: 'Network' },
    ]);
    // Exactly what op printed: --no-newline leaves nothing to trim.
    expect(await provider.password('vaultxyz/itemaaaa')).toBe('s3cret with spaces ');
    expect(calls().at(-1)).toEqual([
      'read',
      '--no-newline',
      'op://vaultxyz/itemaaaa/password',
      '--account',
      'my.1password.com',
    ]);
  });

  it('reports a removed item and refuses a reference that is not two IDs', async () => {
    const provider = new OnePasswordProvider({ program });
    expect(await problemOf(provider.password('vaultxyz/itemzzzz'))).toBe('entry-missing');
    expect(await problemOf(provider.password('vault/item/extra'))).toBe('entry-missing');
    expect(await problemOf(provider.password('../x/y?attribute=otp'))).toBe('entry-missing');
  });

  it('says so when no account is available to the CLI', async () => {
    const empty = fakeProgram('op-empty', `if (has('account', 'list')) out('[]');`);
    const saved = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    try {
      expect(await new OnePasswordProvider({ program: empty.program }).status()).toMatchObject({
        state: 'signed-out',
      });
    } finally {
      if (saved !== undefined) process.env.OP_SERVICE_ACCOUNT_TOKEN = saved;
    }
  });
});

describe.runIf(posix)('Bitwarden', () => {
  const ID = '0a1b2c3d-1111-2222-3333-444455556666';
  const { program, calls } = fakeProgram(
    'bw',
    `
const session = process.env.BW_SESSION;
if (args[0] === 'status') out(JSON.stringify({ status: session === 'session-key' ? 'unlocked' : 'locked' }));
if (args[0] === 'unlock') {
  if (!has('--raw', '--nointeraction', '--passwordenv')) fail('bad unlock arguments', 64);
  if (process.env[args[args.indexOf('--passwordenv') + 1]] !== 'bw-master') fail('Invalid master password.');
  out('session-key');
}
if (args[0] === 'lock') out('Your vault is locked.');
if (session !== 'session-key') fail('Vault is locked.');
if (has('list', 'items')) out(JSON.stringify([
  { id: '${ID}', type: 1, name: 'edge-fw', login: { username: 'fw-admin', password: 'never-kept', uris: [{ uri: 'https://fw' }] } },
  { id: 'note', type: 2, name: 'A note' },
  { id: 'empty', type: 1, name: 'No password', login: { username: 'x', password: null } },
]));
if (has('get', 'password', '${ID}')) out('bw-password\\n');
if (has('get', 'password')) fail('Not found.');
`,
  );

  it('unlocks with the master password and keeps the session key out of the arguments', async () => {
    const provider = new BitwardenProvider({ program });
    expect(await provider.status()).toMatchObject({ state: 'locked' });
    expect(await problemOf(provider.entries())).toBe('locked');
    expect(await problemOf(provider.unlock('wrong'))).toBe('invalid-unlock');

    await provider.unlock('bw-master');
    expect(await provider.status()).toEqual({ state: 'ready' });
    expect(await provider.entries()).toEqual([
      { id: ID, title: 'edge-fw', username: 'fw-admin', url: 'https://fw' },
    ]);
    expect(await provider.password(ID)).toBe('bw-password');
    expect(await problemOf(provider.password('0a1b2c3d-0000-0000-0000-000000000000'))).toBe('entry-missing');
    // A search term instead of an ID would let bw pick an item itself.
    expect(await problemOf(provider.password('edge-fw'))).toBe('entry-missing');

    const flat = calls().flat();
    expect(flat).not.toContain('session-key');
    expect(flat).not.toContain('bw-master');

    await provider.lock();
    expect(await provider.status()).toMatchObject({ state: 'locked' });
  });
});

describe.runIf(posix)('LastPass', () => {
  const { program } = fakeProgram(
    'lpass',
    `
const F = '\\u001f';
if (args[0] === 'status') process.exit(process.env.FAKE_LPASS_OUT ? 1 : 0);
if (process.env.LPASS_DISABLE_PINENTRY !== '1') fail('pinentry would have opened', 70);
if (args[0] === 'ls') {
  if (!args.includes('--format=%ai' + F + '%an' + F + '%au' + F + '%al' + F + '%ag')) fail('bad format', 64);
  out([
    ['4001', 'Network', '', 'http://group', ''],
    ['4002', 'core-sw', 'netops', 'ssh://core-sw', 'Network'],
    ['4003', 'A note', '', 'http://sn', ''],
    ['4004', 'no url', 'me', 'http://', ''],
  ].map((row) => row.join(F)).join('\\n') + '\\n');
}
if (has('show', '--password', '4002')) out('lp-password\\n');
if (args[0] === 'show') fail('\\u001b[1;31mError\\u001b[0m: Could not find specified account(s).');
`,
  );

  it('lists entries without folders and notes, and reads by numeric ID', async () => {
    const provider = new LastPassProvider({ program });
    expect(await provider.status()).toEqual({ state: 'ready' });
    expect(await provider.entries()).toEqual([
      { id: '4004', title: 'no url', username: 'me' },
      { id: '4002', title: 'core-sw', username: 'netops', url: 'ssh://core-sw', group: 'Network' },
    ]);
    expect(await provider.password('4002')).toBe('lp-password');
    expect(await problemOf(provider.password('4999'))).toBe('entry-missing');
    expect(await problemOf(provider.password('core-sw'))).toBe('entry-missing');
  });

  it('reports a CLI that is not logged in', async () => {
    process.env.FAKE_LPASS_OUT = '1';
    try {
      expect(await new LastPassProvider({ program }).status()).toMatchObject({ state: 'signed-out' });
    } finally {
      delete process.env.FAKE_LPASS_OUT;
    }
  });
});

describe.runIf(posix)('Dashlane', () => {
  const ID = 'QD145B53-B987-4CFE-9408-F25803DC47A4'.replace('Q', 'A');
  const { program } = fakeProgram(
    'dcli',
    `
if (args[0] === 'status') out('Logged in: Yes\\nLogin: me@example.com\\nLocked: No\\n');
if (has('password', '--output', 'json')) out(JSON.stringify([
  { id: '{${ID}}', title: 'lab-router', login: 'labadmin', password: 'never-kept', url: 'https://lab' },
  { id: '{11111111-2222-3333-4444-555555555555}', title: '', email: 'me@example.com', url: 'https://mail' },
]));
if (args[0] === 'read' && args[1] === 'dl://${ID}/password') out('dl-password\\n');
if (args[0] === 'read') fail('No matching secret found');
`,
  );

  it('lists credentials and reads one by ID without its braces', async () => {
    const provider = new DashlaneProvider({ program });
    expect(await provider.status()).toEqual({ state: 'ready' });
    expect(await provider.entries()).toEqual([
      { id: '11111111-2222-3333-4444-555555555555', title: 'https://mail', username: 'me@example.com', url: 'https://mail' },
      { id: ID, title: 'lab-router', username: 'labadmin', url: 'https://lab' },
    ]);
    expect(await provider.password(ID)).toBe('dl-password');
    expect(await problemOf(provider.password('11111111-2222-3333-4444-555555555555'))).toBe('entry-missing');
    // A title would make dcli return the first match.
    expect(await problemOf(provider.password('lab-router'))).toBe('entry-missing');
  });
});

describe.runIf(posix)('Proton Pass', () => {
  const { program, calls } = fakeProgram(
    'pass-cli',
    `
if (args[0] === 'info') out('Email: me@proton.me\\n');
if (has('vault', 'list')) out(JSON.stringify({ vaults: [{ name: 'Personal', share_id: 'share1' }, { name: 'Work Stuff' }] }));
if (has('item', 'list', '--share-id', 'share1')) out(JSON.stringify({ folders: [], items: [
  { id: 'item1', content: { title: 'jump host', content: { Login: { username: '', email: 'ops@example.com', urls: ['ssh://jump'] } } } },
] }));
if (has('item', 'list', '--vault-name', 'Work Stuff')) out(JSON.stringify({ items: [
  { id: 'item2', share_id: 'share2', content: { title: 'db', content: { Login: { username: 'dba' } } } },
  { id: 'item3', content: { title: 'by name', content: { Login: { username: 'u' } } } },
] }));
if (has('item', 'view', '--share-id', 'share1', '--item-id', 'item1', '--field', 'password')) out('pp-password\\n');
if (has('item', 'view', '--vault-name', 'Work Stuff', '--item-id', 'item3')) out('by-name-password\\n');
if (has('item', 'view')) fail('Item not found');
`,
  );

  it('lists logins vault by vault and reads by share and item ID', async () => {
    const provider = new ProtonPassProvider({ program });
    expect(await provider.status()).toEqual({ state: 'ready' });
    expect(await provider.entries()).toEqual([
      { id: 'share:share1/item1', title: 'jump host', username: 'ops@example.com', url: 'ssh://jump', group: 'Personal' },
      { id: 'vault:Work%20Stuff/item3', title: 'by name', username: 'u', group: 'Work Stuff' },
      { id: 'share:share2/item2', title: 'db', username: 'dba', group: 'Work Stuff' },
    ]);
    expect(await provider.password('share:share1/item1')).toBe('pp-password');
    expect(await provider.password('vault:Work%20Stuff/item3')).toBe('by-name-password');
    expect(await problemOf(provider.password('share:share1/gone'))).toBe('entry-missing');
    expect(await problemOf(provider.password('item1'))).toBe('entry-missing');
    expect(calls().some((call) => call.includes('--filter-type') && call.includes('login'))).toBe(true);
  });
});

const gpgAvailable = (() => {
  try {
    execFileSync('gpg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(posix && gpgAvailable)('pass', () => {
  it('lists the store and decrypts an entry with gpg', async () => {
    // A short path: gpg-agent's socket lives under GNUPGHOME and has a length limit.
    const home = mkdtempSync(path.join(os.tmpdir(), 'mxg-'));
    const store = path.join(tmp, 'password-store');
    const savedHome = process.env.GNUPGHOME;
    process.env.GNUPGHOME = home;
    chmodSync(home, 0o700);
    try {
      const gpg = (args: string[], input?: string) =>
        execFileSync('gpg', ['--batch', '--quiet', '--yes', ...args], { input, stdio: ['pipe', 'pipe', 'ignore'] });
      gpg(['--passphrase', '', '--pinentry-mode', 'loopback', '--quick-generate-key', 'Muxus Test <muxus@example.invalid>', 'ed25519', 'cert,sign', 'never']);
      const fingerprint = /^fpr:+([0-9A-F]+):/m.exec(gpg(['--list-keys', '--with-colons']).toString())![1]!;
      gpg(['--passphrase', '', '--pinentry-mode', 'loopback', '--quick-add-key', fingerprint, 'cv25519', 'encr', 'never']);

      mkdirSync(path.join(store, 'servers', 'lab'), { recursive: true });
      mkdirSync(path.join(store, '.git'), { recursive: true });
      writeFileSync(path.join(store, '.gpg-id'), `${fingerprint}\n`);
      writeFileSync(path.join(store, '.git', 'ignored.gpg'), 'not an entry');
      const encrypt = (name: string, content: string) =>
        gpg(['--trust-model', 'always', '--recipient', fingerprint, '--output', path.join(store, `${name}.gpg`), '--encrypt'], content);
      encrypt('servers/lab/root', 'pass-password\nuser: root\nurl: ssh://lab\n');
      encrypt('wifi', 'wifi-password');

      const provider = new PassProvider({ path: store });
      expect(await provider.status()).toEqual({ state: 'ready' });
      expect(await provider.entries()).toEqual([
        { id: 'wifi', title: 'wifi' },
        { id: 'servers/lab/root', title: 'root', group: 'servers/lab' },
      ]);
      // Only the first line is the password.
      expect(await provider.password('servers/lab/root')).toBe('pass-password');
      expect(await provider.password('wifi')).toBe('wifi-password');
      expect(await problemOf(provider.password('servers/lab/gone'))).toBe('entry-missing');
      // Nothing outside the store, and nothing hidden inside it.
      expect(await problemOf(provider.password('../outside'))).toBe('entry-missing');
      expect(await problemOf(provider.password('.git/ignored'))).toBe('entry-missing');
    } finally {
      try {
        execFileSync('gpgconf', ['--kill', 'all'], { stdio: 'ignore' });
      } catch {
        // No agent was left running.
      }
      if (savedHome === undefined) delete process.env.GNUPGHOME;
      else process.env.GNUPGHOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('reports a store that does not exist', async () => {
    const provider = new PassProvider({ path: path.join(tmp, 'no-store') });
    expect(await provider.status()).toMatchObject({ state: 'unavailable' });
    expect(await problemOf(provider.entries())).toBe('unavailable');
  });
});
