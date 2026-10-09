import { describe, expect, it } from 'vitest';
import type {
  HostBlockOptions,
  OpenSshProfileMetadata,
  SavedHostProfile,
  SavedHostSessionProfile,
  SessionLoggingPolicy,
  SshHostEntry,
} from '@muxus/shared';
import {
  bulkChangesProblem,
  bulkEditPlan,
  bulkValuesForHost,
  summarizeBulkValues,
  type BulkHostChanges,
} from '../../../client/src/host-bulk-edit.js';
import type { ManagedHost } from '../../../client/src/managed-hosts.js';
import {
  FALLBACK_SESSION_LOGGING_POLICY,
  type HostSessionLoggingDraft,
} from '../../../client/src/session-logging-policy.js';

function openSsh(
  alias: string,
  options: HostBlockOptions = {},
  metadata: Partial<OpenSshProfileMetadata> = {},
): ManagedHost {
  const entry: SshHostEntry = {
    alias,
    aliases: [alias],
    file: '/home/test/.ssh/config',
    options,
    resolved: {
      hostname: `${alias}.example.test`,
      port: options.port ?? 22,
      identityFiles: [],
      certificateFiles: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyJump: [],
      forwards: [],
      passwordOnly: false,
    },
    metadata: { profileId: alias, connectCount: 0, ...metadata },
  };
  return { kind: 'ssh', entry };
}

function saved(
  id: string,
  profile: SavedHostSessionProfile,
  metadata: Partial<OpenSshProfileMetadata> = {},
): ManagedHost {
  const entry: SavedHostProfile = {
    id,
    kind: profile.kind,
    name: id,
    profile,
    metadata: { profileId: id, connectCount: 0, ...metadata },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  return { kind: 'profile', entry };
}

const savedSsh = (id: string, extra: Partial<Extract<SavedHostSessionProfile, { kind: 'ssh' }>> = {}, metadata = {}) =>
  saved(id, { kind: 'ssh', target: `${id}.example.test`, useConfig: false, ...extra }, metadata);
const telnet = (id: string, metadata = {}) =>
  saved(id, { kind: 'telnet', host: `${id}.example.test`, port: 23 }, metadata);
const rdp = (id: string, metadata = {}) =>
  saved(id, { kind: 'rdp', host: `${id}.example.test`, port: 3389 }, metadata);

function policy(profileKey: string, overrides: Partial<SessionLoggingPolicy> = {}): SessionLoggingPolicy {
  return { profileKey, ...FALLBACK_SESSION_LOGGING_POLICY, overridden: false, ...overrides };
}

const customLogging: HostSessionLoggingDraft = {
  ...FALLBACK_SESSION_LOGGING_POLICY,
  enabled: true,
  logToFile: true,
  inherit: false,
  loaded: true,
};

describe('summarizeBulkValues', () => {
  it('reports shared values, mixed values and settings no selected host has', () => {
    const hosts = [
      openSsh('a', { user: 'ops', port: 22 }, { color: '#ef5350', group: 'Lab' }),
      openSsh('b', { user: 'root', port: 22 }, { color: '#ef5350', group: 'Lab/' }),
    ];

    const summary = summarizeBulkValues(hosts, new Map());

    expect(summary.color).toEqual({ state: 'same', count: 2, value: '#ef5350' });
    // Folder paths compare in their normalized form.
    expect(summary.group).toEqual({ state: 'same', count: 2, value: 'Lab' });
    expect(summary.port).toEqual({ state: 'same', count: 2, value: '22' });
    expect(summary.user).toEqual({ state: 'mixed', count: 2 });
  });

  it('counts only the hosts a setting applies to', () => {
    const hosts = [openSsh('a', { user: 'ops' }), telnet('t'), rdp('desk')];

    const summary = summarizeBulkValues(hosts, new Map());

    expect(summary.group).toMatchObject({ count: 3 });
    expect(summary.terminalScheme).toMatchObject({ state: 'same', count: 2 });
    expect(summary.user).toEqual({ state: 'same', count: 1, value: 'ops' });
    expect(summarizeBulkValues([rdp('desk')], new Map()).terminalScheme).toEqual({ state: 'none' });
  });

  it('treats an unset color as a value, but waits for every logging policy', () => {
    const hosts = [openSsh('a'), savedSsh('b')];

    const pending = summarizeBulkValues(hosts, new Map([['ssh:a', policy('ssh:a')]]));
    expect(pending.color).toEqual({ state: 'same', count: 2, value: undefined });
    expect(pending.sessionLogging).toEqual({ state: 'loading', count: 2 });

    const loaded = summarizeBulkValues(
      hosts,
      new Map([
        ['ssh:a', policy('ssh:a')],
        ['profile:b', policy('profile:b', { enabled: true, overridden: true })],
      ]),
    );
    expect(loaded.sessionLogging).toEqual({ state: 'mixed', count: 2 });
  });

  it('reads the highlighting profile and global switch from host metadata', () => {
    const hosts = [
      openSsh('a', {}, { keywordHighlights: { inheritGlobal: true, profileId: 'net', rules: [] } }),
      telnet('t', { keywordHighlights: { inheritGlobal: false, profileId: 'net', rules: [] } }),
    ];

    const summary = summarizeBulkValues(hosts, new Map());

    expect(summary.highlightProfileId).toEqual({ state: 'same', count: 2, value: 'net' });
    expect(summary.highlightInheritGlobal).toEqual({ state: 'mixed', count: 2 });
  });
});

describe('bulkValuesForHost', () => {
  it('reads connection flags as unset, on or off', () => {
    expect(
      bulkValuesForHost(openSsh('a', { forwardAgent: false, forwardX11: true, strictHostKeyChecking: 'no' })),
    ).toMatchObject({ forwardAgent: 'no', forwardX11: 'yes', strictHostKeyChecking: 'no' });
    expect(bulkValuesForHost(savedSsh('b'))).toMatchObject({
      forwardAgent: 'inherit',
      forwardX11: 'inherit',
      strictHostKeyChecking: 'inherit',
      user: '',
      port: '',
    });
  });
});

describe('bulkEditPlan', () => {
  it('sends one Host block patch for OpenSSH hosts and saves Muxus hosts whole', () => {
    const hosts = [
      openSsh('a', { user: 'old' }),
      openSsh('b'),
      savedSsh('s', { user: 'old', port: 2222, identityFiles: ['~/.ssh/id_ed25519'] }),
    ];

    const plan = bulkEditPlan(hosts, { user: ' ops ', port: '' });

    expect(plan.openSsh).toEqual({ aliases: ['a', 'b'], options: { user: 'ops', port: null } });
    expect(plan.profiles).toEqual([
      {
        id: 's',
        name: 's',
        profile: {
          kind: 'ssh',
          target: 's.example.test',
          useConfig: false,
          user: 'ops',
          identityFiles: ['~/.ssh/id_ed25519'],
        },
      },
    ]);
    expect(plan.metadata).toEqual([]);
    expect(plan.hosts).toHaveLength(3);
  });

  it('skips hosts that already have every changed value', () => {
    const hosts = [
      openSsh('a', { user: 'ops' }, { color: '#4285f4' }),
      openSsh('b', { user: 'root' }, { color: '#4285f4' }),
    ];

    const plan = bulkEditPlan(hosts, { user: 'ops', color: '#4285f4' });

    expect(plan.hosts.map((host) => host.entry.metadata?.profileId)).toEqual(['b']);
    expect(plan.openSsh?.aliases).toEqual(['b']);
    expect(plan.metadata).toEqual([]);
    expect(plan.fieldCounts).toEqual({ user: 1, color: 0 });
  });

  it('clears a value with a present-but-undefined change', () => {
    const hosts = [openSsh('a', {}, { color: '#4285f4', terminalScheme: 'nord' }), rdp('desk', { color: '#ef5350' })];

    const plan = bulkEditPlan(hosts, { color: undefined, terminalScheme: undefined });

    expect(plan.metadata.map(({ patch }) => patch)).toEqual([
      { color: null, terminalScheme: null },
      // A remote desktop has no terminal scheme to clear.
      { color: null },
    ]);
  });

  it('only changes the highlighting profile and switch, keeping each host its own rules', () => {
    const rule = {
      id: 'r1',
      keyword: 'ERROR',
      foreground: '#ffffff',
      caseSensitive: false,
      wholeWord: true,
    };
    const hosts = [
      openSsh('a', {}, { keywordHighlights: { inheritGlobal: true, rules: [rule] } }),
      telnet('t'),
      openSsh('c', {}, { keywordHighlights: { inheritGlobal: true, profileId: 'old', rules: [] } }),
    ];

    const set = bulkEditPlan(hosts, { highlightProfileId: 'net' });
    expect(set.metadata.map(({ patch }) => patch.keywordHighlights)).toEqual([
      { inheritGlobal: true, profileId: 'net', rules: [rule] },
      { inheritGlobal: true, profileId: 'net', rules: [] },
      { inheritGlobal: true, profileId: 'net', rules: [] },
    ]);

    // Back to the default stores nothing at all, as the host editor does.
    const cleared = bulkEditPlan(hosts, { highlightProfileId: undefined });
    expect(cleared.metadata.map(({ patch }) => patch.keywordHighlights)).toEqual([null]);
  });

  it('sets and clears the command button group on terminal hosts only', () => {
    const hosts = [
      openSsh('a', {}, { commandButtonGroup: 'juniper' }),
      telnet('t'),
      rdp('desk'),
    ];

    expect(summarizeBulkValues(hosts, new Map()).commandButtonGroup).toEqual({
      state: 'mixed',
      count: 2,
    });
    const set = bulkEditPlan(hosts, { commandButtonGroup: 'juniper' });
    expect(set.metadata).toEqual([
      { host: hosts[1], patch: { commandButtonGroup: 'juniper' } },
    ]);
    const cleared = bulkEditPlan(hosts, { commandButtonGroup: undefined });
    expect(cleared.metadata).toEqual([
      { host: hosts[0], patch: { commandButtonGroup: null } },
    ]);
  });

  it('sets paste delays on terminal hosts and clears them back to the settings', () => {
    const hosts = [
      openSsh('a', {}, { pasteLineDelayMs: 200 }),
      telnet('t', { pasteLineDelayMs: 0 }),
      saved('console', {
        kind: 'serial',
        path: '/dev/ttyUSB0',
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      }),
      rdp('desk'),
    ];

    // An explicit 0 differs from following the settings.
    expect(summarizeBulkValues(hosts, new Map()).pasteLineDelayMs).toEqual({
      state: 'mixed',
      count: 3,
    });
    expect(summarizeBulkValues(hosts, new Map()).pasteCharDelayMs).toEqual({
      state: 'same',
      count: 3,
      value: undefined,
    });
    const set = bulkEditPlan(hosts, { pasteLineDelayMs: 200, pasteCharDelayMs: 2 });
    expect(set.metadata).toEqual([
      { host: hosts[0], patch: { pasteCharDelayMs: 2 } },
      { host: hosts[1], patch: { pasteLineDelayMs: 200, pasteCharDelayMs: 2 } },
      { host: hosts[2], patch: { pasteLineDelayMs: 200, pasteCharDelayMs: 2 } },
    ]);
    const cleared = bulkEditPlan(hosts, { pasteLineDelayMs: undefined });
    expect(cleared.metadata).toEqual([
      { host: hosts[0], patch: { pasteLineDelayMs: null } },
      { host: hosts[1], patch: { pasteLineDelayMs: null } },
    ]);
  });

  it('applies terminal and SSH settings only where they mean something', () => {
    const hosts = [openSsh('a'), telnet('t'), rdp('desk')];

    const plan = bulkEditPlan(hosts, {
      consoleCompatibility: true,
      terminalFontColor: '#00ff00',
      group: 'Lab / Edge',
    });

    expect(plan.metadata).toEqual([
      {
        host: hosts[0],
        patch: { group: 'Lab/Edge', terminalFontColor: '#00ff00', consoleCompatibility: true },
      },
      { host: hosts[1], patch: { group: 'Lab/Edge', terminalFontColor: '#00ff00' } },
      { host: hosts[2], patch: { group: 'Lab/Edge' } },
    ]);
    expect(plan.openSsh).toBeUndefined();
  });

  it('removes connection options when set back to their defaults', () => {
    const hosts = [savedSsh('s', { forwardAgent: true, forwardX11: false, strictHostKeyChecking: 'no' })];

    const plan = bulkEditPlan(hosts, {
      forwardAgent: 'inherit',
      forwardX11: 'yes',
      strictHostKeyChecking: 'inherit',
    });

    expect(plan.profiles[0]?.profile).toEqual({
      kind: 'ssh',
      target: 's.example.test',
      useConfig: false,
      forwardX11: true,
    });
  });

  it('writes or removes logging overrides for terminal hosts', () => {
    const hosts = [openSsh('a'), telnet('t'), rdp('desk')];
    const policies = new Map([
      ['ssh:a', policy('ssh:a')],
      ['profile:t', policy('profile:t', { ...customLogging, overridden: true })],
    ]);

    const custom = bulkEditPlan(hosts, { sessionLogging: customLogging }, policies);
    expect(custom.logging).toEqual([
      {
        profileKey: 'ssh:a',
        policy: { enabled: true, captureInput: false, maxPartBytes: 5 * 1024 * 1024, maxParts: 10, logToFile: true },
      },
    ]);

    const inherit = bulkEditPlan(hosts, { sessionLogging: { ...customLogging, inherit: true } }, policies);
    expect(inherit.logging).toEqual([{ profileKey: 'profile:t', policy: null }]);
  });

  it('writes logging for a host whose policy is not known yet', () => {
    const plan = bulkEditPlan([openSsh('a')], { sessionLogging: customLogging });
    expect(plan.logging.map(({ profileKey }) => profileKey)).toEqual(['ssh:a']);
  });
});

describe('bulkChangesProblem', () => {
  it.each<[BulkHostChanges, string | null]>([
    [{ port: '22' }, null],
    [{ port: '' }, null],
    [{ port: '0' }, 'Port must be 1–65535.'],
    [{ port: '70000' }, 'Port must be 1–65535.'],
    [{ user: 'a"b' }, 'The user name cannot contain quotes or line breaks.'],
    [{ group: 'a/b/c/d/e/f/g/h/i' }, 'Folders can nest 8 levels deep.'],
    [{ group: 'x'.repeat(301) }, 'That folder path is longer than 300 characters.'],
  ])('%o → %s', (changes, problem) => {
    expect(bulkChangesProblem(changes)).toBe(problem);
  });
});
