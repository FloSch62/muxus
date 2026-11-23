import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../client/src/api/http.js';
import { savedHostHop, type HostUpsertRequest, type SavedHostProfile } from '@muxus/shared';
import {
  BACKUP_FORMAT,
  PREFERENCE_KEYS,
  TRANSFER_VERSION,
  createBackupDocument,
  createOpenSshExport,
  parseTransferDocument,
  restoreImportedConnections,
  restoreTransferDocument,
  sanitizePreferences,
  type BackupPreferences,
} from '../../../client/src/data-transfer.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';
import { customSchemeCopyOf } from '../../../client/src/terminal/custom-schemes.js';
import { terminalScheme } from '../../../client/src/terminal/palette.js';

vi.mock('../../../client/src/api/http.js', () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  apiFetchMock.mockReset();
  usePrefsStore.setState({
    notifyOnNewVersion: true,
    showCommandBar: true,
    commandBarPosition: 'top',
    sidebarPosition: 'left',
    sidebarOpenGesture: 'click',
    showStatusBar: false,
    statusBarItems: ['hostname', 'cpu'],
    backgroundColor: '',
    lightTerminalScheme: 'vscode-light',
    darkTerminalScheme: 'vscode-dark',
    customTerminalSchemes: [],
    activePaneBorder: false,
    dimInactivePanes: false,
    inactivePaneDimStrength: 0.15,
    terminalFileLinkActivation: 'alt',
    localShellProfiles: [],
    defaultLocalShellProfileId: '',
    showWslDistributions: true,
    sshSessionSummary: false,
    rememberPasswordsByDefault: false,
    newSshHostStorage: 'openssh',
    keywordHighlightProfiles: [],
    pasteWarnLookalikes: true,
    showHiddenFiles: true,
  });
});

const connections = {
  sshHosts: [
    {
      alias: 'production',
      aliases: ['production'],
      options: { hostname: 'prod.example.com', user: 'deploy' },
      metadata: { group: 'Work' },
    },
  ],
  savedHosts: [],
  hostOrder: [{ kind: 'ssh', alias: 'production' }],
};

function mockExistingMultiAliasHost(): void {
  apiFetchMock
    .mockResolvedValueOnce({
      path: '/home/test/.ssh/config',
      files: ['/home/test/.ssh/config'],
      hosts: [
        {
          alias: 'production',
          aliases: ['production', 'prod-alt'],
          file: '/home/test/.ssh/config',
        },
      ],
    })
    .mockResolvedValueOnce({ profiles: [] });
}

describe('Muxus transfer file parsing', () => {
  it('accepts a versioned full backup', () => {
    const document = {
      format: BACKUP_FORMAT,
      version: TRANSFER_VERSION,
      createdAt: '2026-07-24T12:00:00.000Z',
      appVersion: '0.1.0',
      data: {
        ...connections,
        preferences: {},
        tunnels: [],
        loggingPolicies: [],
        historySettings: {
          maxTotalBytes: 5 * 1024 ** 3,
          minFreeBytes: 2 * 1024 ** 3,
          minFreePercent: 5,
        },
      },
    };

    expect(parseTransferDocument(JSON.stringify(document))).toEqual(document);
  });

  it('keeps reading legacy version-1 backups', () => {
    const document = {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: '2026-07-24T12:00:00.000Z',
      data: {
        sshHosts: [],
        savedHosts: [
          {
            id: 'legacy-telnet',
            name: 'Console',
            profile: { kind: 'telnet', host: 'console.example.test', port: 23 },
            metadata: {},
          },
        ],
        hostOrder: [{ kind: 'profile', id: 'legacy-telnet' }],
        preferences: {},
        tunnels: [],
        loggingPolicies: [],
        historySettings: {
          maxTotalBytes: 5 * 1024 ** 3,
          minFreeBytes: 2 * 1024 ** 3,
          minFreePercent: 5,
        },
      },
    };

    expect(parseTransferDocument(JSON.stringify(document))).toEqual(document);
  });

  it('requires version 2 for saved SSH profiles', () => {
    expect(() =>
      parseTransferDocument(
        JSON.stringify({
          format: BACKUP_FORMAT,
          version: 1,
          createdAt: '2026-07-24T12:00:00.000Z',
          data: {
            sshHosts: [],
            savedHosts: [
              {
                id: 'saved-ssh',
                name: 'Router',
                profile: {
                  kind: 'ssh',
                  target: 'router.example.test',
                  useConfig: false,
                },
                metadata: {},
              },
            ],
            hostOrder: [{ kind: 'profile', id: 'saved-ssh' }],
            preferences: {},
            tunnels: [],
            loggingPolicies: [],
            historySettings: {
              maxTotalBytes: 5 * 1024 ** 3,
              minFreeBytes: 2 * 1024 ** 3,
              minFreePercent: 5,
            },
          },
        }),
      ),
    ).toThrow('The connection data in this file is incomplete or too large.');
  });

  it('rejects invalid JSON with a useful error', () => {
    expect(() => parseTransferDocument('{not json')).toThrow(
      'This file is not valid JSON.',
    );
  });

  it('rejects future versions before inspecting their data', () => {
    expect(() =>
      parseTransferDocument(
        JSON.stringify({
          format: BACKUP_FORMAT,
          version: TRANSFER_VERSION + 1,
          createdAt: '2026-07-24T12:00:00.000Z',
          data: {},
        }),
      ),
    ).toThrow(
      `Muxus transfer version ${TRANSFER_VERSION + 1} is not supported.`,
    );
  });

  it('rejects malformed connection entries before restore can write', () => {
    expect(() =>
      parseTransferDocument(
        JSON.stringify({
          format: BACKUP_FORMAT,
          version: TRANSFER_VERSION,
          createdAt: '2026-07-24T12:00:00.000Z',
          data: {
            sshHosts: [{ alias: 'broken', aliases: [], options: {} }],
            savedHosts: [],
            hostOrder: [],
            preferences: {},
            tunnels: [],
            loggingPolicies: [],
            historySettings: {
              maxTotalBytes: 5 * 1024 ** 3,
              minFreeBytes: 2 * 1024 ** 3,
              minFreePercent: 5,
            },
          },
        }),
      ),
    ).toThrow('The connection data in this file is incomplete or too large.');
  });
});

function mockBackupSnapshot(
  folders: unknown[] = [],
  profiles: unknown[] = [],
  policies: unknown[] = [],
  sharedSessionSources: unknown[] = [],
  library: {
    passwordManagers?: unknown[];
    workspaces?: { id: string }[];
    scripts?: unknown[];
    requests?: unknown[];
  } = {},
): void {
  apiFetchMock
    .mockResolvedValueOnce({ hosts: [] })
    .mockResolvedValueOnce({ profiles })
    .mockResolvedValueOnce({ tunnels: [] });
  for (let index = 0; index < 2 + profiles.length; index++) {
    apiFetchMock.mockResolvedValueOnce(policies[index] ?? { overridden: false });
  }
  apiFetchMock
    .mockResolvedValueOnce({
      settings: {
        storageLocation: '/tmp/muxus-history',
        maxTotalBytes: 5 * 1024 ** 3,
        minFreeBytes: 2 * 1024 ** 3,
        minFreePercent: 5,
      },
    })
    .mockResolvedValueOnce({
      settings: {
        directory: '/home/test/logs',
        filenamePattern: '{host}/{date}.log',
        timestamps: true,
      },
      activeDirectory: '/home/test/logs',
    })
    .mockResolvedValueOnce({ folders })
    .mockResolvedValueOnce({ sources: sharedSessionSources })
    .mockResolvedValueOnce({ sources: library.passwordManagers ?? [], installed: [] })
    .mockResolvedValueOnce({ workspaces: library.workspaces ?? [] })
    .mockResolvedValueOnce({ scripts: library.scripts ?? [] })
    .mockResolvedValueOnce({ requests: library.requests ?? [] });
  // The list of workspaces has no layouts; each one is then read in full.
  for (const workspace of library.workspaces ?? []) apiFetchMock.mockResolvedValueOnce(workspace);
}

describe('backing up session log files', () => {
  const historySettings = {
    maxTotalBytes: 5 * 1024 ** 3,
    minFreeBytes: 2 * 1024 ** 3,
    minFreePercent: 5,
  };

  it('keeps each policy\'s log file choice and the settings without the folder', async () => {
    mockBackupSnapshot([], [], [
      {
        profileKey: '*',
        enabled: false,
        captureInput: false,
        maxPartBytes: 1024 * 1024,
        maxParts: 2,
        logToFile: true,
        overridden: true,
      },
    ]);

    const document = await createBackupDocument();

    expect(document.data.loggingPolicies).toEqual([
      {
        profileKey: '*',
        policy: {
          enabled: false,
          captureInput: false,
          maxPartBytes: 1024 * 1024,
          maxParts: 2,
          logToFile: true,
        },
      },
    ]);
    expect(document.data.logFileSettings).toEqual({
      filenamePattern: '{host}/{date}.log',
      timestamps: true,
    });
    expect(parseTransferDocument(JSON.stringify(document))).toEqual(document);
  });

  it('rejects malformed log file settings', () => {
    expect(() =>
      parseTransferDocument(
        JSON.stringify({
          format: BACKUP_FORMAT,
          version: TRANSFER_VERSION,
          createdAt: '2026-10-04T12:00:00.000Z',
          data: {
            ...connections,
            preferences: {},
            tunnels: [],
            loggingPolicies: [],
            historySettings,
            logFileSettings: { filenamePattern: '', timestamps: 'yes' },
          },
        }),
      ),
    ).toThrow('The backup data is incomplete or too large.');
  });

  it('accepts saved tunnels with or without their switches and rejects malformed ones', () => {
    const backup = (tunnels: unknown[]) =>
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: TRANSFER_VERSION,
        createdAt: '2026-10-08T12:00:00.000Z',
        data: { ...connections, preferences: {}, tunnels, loggingPolicies: [], historySettings },
      });
    const tunnel = { id: 'tunnel-1', target: 'db', type: 'dynamic', bindPort: 1080 };

    const switched = { ...tunnel, id: 'tunnel-2', autoStart: true, autoReconnect: true };
    expect(parseTransferDocument(backup([tunnel, switched])).data).toMatchObject({ tunnels: [tunnel, switched] });
    for (const malformed of [{ autoStart: 'yes' }, { autoReconnect: 'yes' }]) {
      expect(() => parseTransferDocument(backup([{ ...tunnel, ...malformed }]))).toThrow(
        'The backup data is incomplete or too large.',
      );
    }
  });

  it('restores the settings into this machine\'s log folder', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ settings: { storageLocation: '/srv/history' } })
      .mockResolvedValueOnce({
        settings: { directory: '/srv/logs', filenamePattern: '{host}.log', timestamps: false },
      })
      .mockResolvedValue({});

    await restoreTransferDocument(
      parseTransferDocument(
        JSON.stringify({
          format: BACKUP_FORMAT,
          version: TRANSFER_VERSION,
          createdAt: '2026-10-04T12:00:00.000Z',
          data: {
            ...connections,
            preferences: {},
            tunnels: [],
            loggingPolicies: [],
            historySettings,
            logFileSettings: { filenamePattern: '{kind}/{host}.log', timestamps: true },
          },
        }),
      ),
      { preferences: false, connections: false, tunnels: false, logging: true, workspaces: false, library: false },
      'replace',
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/session-history/log-files',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          filenamePattern: '{kind}/{host}.log',
          timestamps: true,
          directory: '/srv/logs',
        }),
      }),
    );
  });
});

describe('backing up preferences', () => {
  it('keeps a secret command button as a reference to the vault', async () => {
    const enable = {
      id: 'enable',
      label: 'Enable',
      command: '',
      sendEnter: true,
      secretId: 'vault-secret-1',
      shortcut: 'Ctrl+Alt+KeyE',
    };
    usePrefsStore.setState({ commandButtons: [enable] });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.commandButtons).toEqual([enable]);
    // The backup never asks the vault for anything.
    expect(apiFetchMock.mock.calls.map(([url]) => String(url))).not.toContainEqual(
      expect.stringContaining('/api/password-vault'),
    );
    expect(
      sanitizePreferences({ commandButtons: [enable] } as unknown as BackupPreferences).commandButtons,
    ).toEqual([enable]);
    usePrefsStore.setState({ commandButtons: [] });
  });

  it('includes display and update-notification choices', async () => {
    usePrefsStore.setState({
      notifyOnNewVersion: false,
      showCommandBar: false,
      commandBarPosition: 'bottom',
      sidebarPosition: 'right',
      sidebarOpenGesture: 'double-click',
      showStatusBar: true,
      statusBarItems: ['memory', 'network'],
      backgroundColor: '#102030',
      lightTerminalScheme: 'paper',
      darkTerminalScheme: 'dracula',
      activePaneBorder: false,
      dimInactivePanes: true,
      inactivePaneDimStrength: 0.35,
      terminalFileLinkActivation: 'ctrl',
    });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.notifyOnNewVersion).toBe(false);
    expect(document.data.preferences.backgroundColor).toBe('#102030');
    expect(document.data.preferences.showCommandBar).toBe(false);
    expect(document.data.preferences.commandBarPosition).toBe('bottom');
    expect(document.data.preferences.sidebarPosition).toBe('right');
    expect(document.data.preferences.sidebarOpenGesture).toBe('double-click');
    expect(document.data.preferences.showStatusBar).toBe(true);
    expect(document.data.preferences.statusBarItems).toEqual(['memory', 'network']);
    expect(document.data.preferences.lightTerminalScheme).toBe('paper');
    expect(document.data.preferences.darkTerminalScheme).toBe('dracula');
    expect(document.data.preferences.activePaneBorder).toBe(false);
    expect(document.data.preferences.dimInactivePanes).toBe(true);
    expect(document.data.preferences.inactivePaneDimStrength).toBe(0.35);
    expect(document.data.preferences.terminalFileLinkActivation).toBe('ctrl');
  });

  it('includes custom terminal color schemes', async () => {
    const custom = customSchemeCopyOf(terminalScheme('nord'), []);
    usePrefsStore.setState({ customTerminalSchemes: [custom], darkTerminalScheme: custom.id });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.customTerminalSchemes).toEqual([custom]);
    expect(document.data.preferences.darkTerminalScheme).toBe(custom.id);
  });

  it('includes saved local shell profiles and their default selection', async () => {
    usePrefsStore.setState({
      localShellProfiles: [
        {
          id: 'ubuntu',
          name: 'Ubuntu',
          shell: 'wsl.exe',
          args: ['-d', 'Ubuntu'],
          cwd: 'C:\\work',
          startupCommand: 'cd project',
        },
      ],
      defaultLocalShellProfileId: 'ubuntu',
      showWslDistributions: false,
    });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.localShellProfiles).toHaveLength(1);
    expect(document.data.preferences.defaultLocalShellProfileId).toBe('ubuntu');
    expect(document.data.preferences.showWslDistributions).toBe(false);
  });

  it('includes reusable keyword highlighting profiles', async () => {
    const profile = {
      id: 'nokia-sros',
      name: 'Nokia SR OS',
      rules: [
        {
          id: 'alarm',
          keyword: 'MAJOR',
          foreground: '#ffffff',
          caseSensitive: true,
          wholeWord: true,
        },
      ],
    };
    usePrefsStore.setState({ keywordHighlightProfiles: [profile] });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.keywordHighlightProfiles).toEqual([profile]);
  });

  it('includes the look-alike paste confirmation', async () => {
    usePrefsStore.setState({ pasteWarnLookalikes: false });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.pasteWarnLookalikes).toBe(false);
  });

  it('includes closing tabs when their shell exits', async () => {
    usePrefsStore.setState({ closeTabOnCleanExit: true });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.closeTabOnCleanExit).toBe(true);
  });

  it('includes whether the file browser lists hidden files', async () => {
    usePrefsStore.setState({ showHiddenFiles: false });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.showHiddenFiles).toBe(false);
  });
});

describe('restoring terminal file link activation preferences', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it.each(['direct', 'alt', 'ctrl', 'meta'] as const)('restores %s activation', (value) => {
    expect(sanitizePreferences(prefs({ terminalFileLinkActivation: value }))).toMatchObject({
      terminalFileLinkActivation: value,
    });
  });

  it('drops malformed activation settings', () => {
    expect(
      sanitizePreferences(prefs({ terminalFileLinkActivation: 'double-click' }))
        .terminalFileLinkActivation,
    ).toBeUndefined();
  });
});

describe('restoring paste pacing preferences', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores delays in range and drops the rest', () => {
    expect(
      sanitizePreferences(prefs({ pasteLineDelayMs: 300, pasteCharDelayMs: 0 })),
    ).toMatchObject({ pasteLineDelayMs: 300, pasteCharDelayMs: 0 });
    const restored = sanitizePreferences(
      prefs({ pasteLineDelayMs: 60_000, pasteCharDelayMs: 'slow' }),
    );
    expect(restored.pasteLineDelayMs).toBeUndefined();
    expect(restored.pasteCharDelayMs).toBeUndefined();
  });
});

describe('restoring terminal color scheme preferences', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores separate light and dark selections', () => {
    expect(
      sanitizePreferences(
        prefs({ lightTerminalScheme: 'paper', darkTerminalScheme: 'dracula' }),
      ),
    ).toMatchObject({
      lightTerminalScheme: 'paper',
      darkTerminalScheme: 'dracula',
    });
  });

  it('restores a legacy single selection into both appearances', () => {
    expect(sanitizePreferences(prefs({ terminalScheme: 'nord' }))).toMatchObject({
      lightTerminalScheme: 'nord',
      darkTerminalScheme: 'nord',
    });
  });

  it('drops malformed selections', () => {
    const restored = sanitizePreferences(
      prefs({ lightTerminalScheme: 42, darkTerminalScheme: 'x'.repeat(101) }),
    );
    expect(restored.lightTerminalScheme).toBeUndefined();
    expect(restored.darkTerminalScheme).toBeUndefined();
  });

  it('restores custom schemes and drops a malformed list', () => {
    const custom = customSchemeCopyOf(terminalScheme('nord'), []);

    expect(
      sanitizePreferences(
        prefs({ customTerminalSchemes: [custom], darkTerminalScheme: custom.id }),
      ),
    ).toMatchObject({ customTerminalSchemes: [custom], darkTerminalScheme: custom.id });
    expect(
      sanitizePreferences(prefs({ customTerminalSchemes: [{ ...custom, name: '' }] }))
        .customTerminalSchemes,
    ).toBeUndefined();
  });
});

describe('restoring split pane focus preferences', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores the two indicators and dimming strength independently', () => {
    expect(
      sanitizePreferences(
        prefs({ activePaneBorder: false, dimInactivePanes: true, inactivePaneDimStrength: 0.35 }),
      ),
    ).toMatchObject({
      activePaneBorder: false,
      dimInactivePanes: true,
      inactivePaneDimStrength: 0.35,
    });
  });

  it('drops malformed or unreadable dimming choices', () => {
    const restored = sanitizePreferences(
      prefs({ activePaneBorder: 'yes', dimInactivePanes: 'yes', inactivePaneDimStrength: 0.9 }),
    );
    expect(restored.activePaneBorder).toBeUndefined();
    expect(restored.dimInactivePanes).toBeUndefined();
    expect(restored.inactivePaneDimStrength).toBeUndefined();
  });
});

describe('restoring local shell profiles', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;
  const ubuntu = {
    id: 'ubuntu',
    name: 'Ubuntu',
    shell: 'wsl.exe',
    args: ['-d', 'Ubuntu'],
    cwd: 'C:\\work',
    startupCommand: 'cd project',
  };

  it('restores bounded profiles and their default selection', () => {
    expect(
      sanitizePreferences(
        prefs({ localShellProfiles: [ubuntu], defaultLocalShellProfileId: 'ubuntu' }),
      ),
    ).toMatchObject({
      localShellProfiles: [ubuntu],
      defaultLocalShellProfileId: 'ubuntu',
    });
  });

  it('drops malformed profiles rather than importing them', () => {
    expect(
      sanitizePreferences(prefs({ localShellProfiles: [{ ...ubuntu, args: '-d Ubuntu' }] }))
        .localShellProfiles,
    ).toBeUndefined();
  });

  it('restores whether installed WSL distributions are listed', () => {
    expect(sanitizePreferences(prefs({ showWslDistributions: false }))).toMatchObject({
      showWslDistributions: false,
    });
    expect(
      sanitizePreferences(prefs({ showWslDistributions: 'false' })).showWslDistributions,
    ).toBeUndefined();
  });
});

describe('restoring the SSH session summary preference', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores the switch and drops a malformed value', () => {
    expect(sanitizePreferences(prefs({ sshSessionSummary: true }))).toMatchObject({
      sshSessionSummary: true,
    });
    expect(
      sanitizePreferences(prefs({ sshSessionSummary: 'on' })).sshSessionSummary,
    ).toBeUndefined();
  });

  it('is part of a backup', async () => {
    usePrefsStore.setState({ sshSessionSummary: true });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.sshSessionSummary).toBe(true);
  });
});

describe('restoring the new-host and password prompt defaults', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores valid choices and drops malformed values', () => {
    expect(
      sanitizePreferences(
        prefs({ rememberPasswordsByDefault: true, newSshHostStorage: 'muxus' }),
      ),
    ).toMatchObject({ rememberPasswordsByDefault: true, newSshHostStorage: 'muxus' });
    const malformed = sanitizePreferences(
      prefs({ rememberPasswordsByDefault: 1, newSshHostStorage: 'database' }),
    );
    expect(malformed.rememberPasswordsByDefault).toBeUndefined();
    expect(malformed.newSshHostStorage).toBeUndefined();
  });

  it('are part of a backup', async () => {
    usePrefsStore.setState({ rememberPasswordsByDefault: true, newSshHostStorage: 'muxus' });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences).toMatchObject({
      rememberPasswordsByDefault: true,
      newSshHostStorage: 'muxus',
    });
  });
});

describe('restoring keyword highlighting profiles', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;
  const profile = {
    id: 'nokia-sros',
    name: 'Nokia SR OS',
    rules: [
      {
        id: 'alarm',
        keyword: 'MAJOR',
        foreground: '#ffffff',
        caseSensitive: true,
        wholeWord: true,
      },
    ],
  };

  it('restores bounded reusable profiles', () => {
    expect(
      sanitizePreferences(prefs({ keywordHighlightProfiles: [profile] })),
    ).toMatchObject({ keywordHighlightProfiles: [profile] });
  });

  it('drops malformed reusable profiles', () => {
    expect(
      sanitizePreferences(
        prefs({ keywordHighlightProfiles: [{ ...profile, name: '' }] }),
      ).keywordHighlightProfiles,
    ).toBeUndefined();
  });
});

describe('backing up folder credentials', () => {
  it('exports folder auth defaults but never password-only rows', async () => {
    mockBackupSnapshot([
      { id: 'a', path: 'Prod', auth: { user: 'root', port: 2222 }, hasPassword: true },
      // A folder whose only setting is its vault password: the password
      // cannot leave the vault, so there is nothing to export.
      { id: 'b', path: 'Lab', auth: {}, hasPassword: true },
    ]);

    const document = await createBackupDocument();

    expect(document.data.folderSettings).toEqual([
      { path: 'Prod', auth: { user: 'root', port: 2222 } },
    ]);
  });
});

describe('backing up login sequences', () => {
  const sequence = {
    steps: [
      { id: 'w', kind: 'wait', pattern: 'Password:', timeoutSeconds: 10 },
      { id: 'k', kind: 'secret', secretId: 'vault-secret-1', enter: true },
    ],
  };

  it('exports host and folder sequences as references, including sequence-only folders', async () => {
    mockBackupSnapshot(
      [
        { id: 'a', path: 'Network', auth: {}, hasPassword: true, loginSequence: sequence },
        { id: 'b', path: 'Lab', auth: { user: 'lab' }, hasPassword: false },
      ],
      [
        {
          id: 'console',
          kind: 'telnet',
          name: 'Console',
          profile: { kind: 'telnet', host: 'console.example.test', port: 23 },
          metadata: { profileId: 'console', loginSequence: { steps: [] }, connectCount: 0 },
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z',
        },
      ],
    );

    const document = await createBackupDocument();

    expect(document.data.folderSettings).toEqual([
      { path: 'Network', auth: {}, loginSequence: sequence },
      { path: 'Lab', auth: { user: 'lab' } },
    ]);
    expect(document.data.savedHosts[0]?.metadata.loginSequence).toEqual({ steps: [] });
    // A round trip through the file keeps it, and keeps every secret out of it.
    const text = JSON.stringify(document);
    expect(parseTransferDocument(text).data.folderSettings?.[0]?.loginSequence).toEqual(sequence);
    expect(text).toContain('vault-secret-1');
  });

  it('restores valid sequences and drops a malformed one rather than the folder', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ hosts: [] })
      .mockResolvedValueOnce({ profiles: [] })
      .mockResolvedValueOnce({ folders: [] })
      .mockResolvedValue({ folder: null });
    const backup = {
      format: 'muxus-backup',
      version: 2,
      createdAt: '2026-08-10T00:00:00.000Z',
      data: {
        ...connections,
        sshHosts: [],
        hostOrder: [],
        preferences: {},
        tunnels: [],
        loggingPolicies: [],
        historySettings: { maxTotalBytes: 1, minFreeBytes: 0, minFreePercent: 0 },
        folderSettings: [
          { path: 'Network', auth: {}, loginSequence: sequence },
          { path: 'Broken', auth: { user: 'x' }, loginSequence: { steps: [{ kind: 'wait' }] } },
        ],
      },
    };

    await restoreTransferDocument(
      parseTransferDocument(JSON.stringify(backup)),
      { preferences: false, connections: true, tunnels: false, logging: false, workspaces: false, library: false },
      'replace',
    );

    const puts = apiFetchMock.mock.calls
      .filter(([url, init]) => url === '/api/folders/settings' && init?.method === 'PUT')
      .map(([, init]) => JSON.parse(init?.body as string) as unknown);
    expect(puts).toEqual([
      { path: 'Network', auth: {}, loginSequence: sequence },
      { path: 'Broken', auth: { user: 'x' } },
    ]);
  });
});

describe('backing up host terminal schemes', () => {
  it('keeps the per-host override in portable metadata', async () => {
    mockBackupSnapshot([], [
      {
        id: 'console',
        kind: 'telnet',
        name: 'Console',
        profile: { kind: 'telnet', host: 'console.example.test', port: 23 },
        metadata: {
          profileId: 'console',
          terminalScheme: 'solarized-dark',
          terminalFontColor: '#fdf6e3',
          terminalBackgroundColor: '#002b36',
          pasteLineDelayMs: 200,
          pasteCharDelayMs: 0,
          pastePromptWait: { timeoutMs: 20_000 },
          antiIdle: { intervalSeconds: 120, text: ' ', enter: false },
          backspaceKey: 'ctrl-h',
          enterKey: 'crlf',
          localEcho: true,
          connectCount: 0,
        },
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
      },
    ]);

    const document = await createBackupDocument();

    expect(document.data.savedHosts[0]?.metadata.terminalScheme).toBe('solarized-dark');
    expect(document.data.savedHosts[0]?.metadata.terminalFontColor).toBe('#fdf6e3');
    expect(document.data.savedHosts[0]?.metadata.terminalBackgroundColor).toBe('#002b36');
    // An explicit 0 is an override too: this host is never paced.
    expect(document.data.savedHosts[0]?.metadata).toMatchObject({
      pasteLineDelayMs: 200,
      pasteCharDelayMs: 0,
      pastePromptWait: { timeoutMs: 20_000 },
      antiIdle: { intervalSeconds: 120, text: ' ', enter: false },
      backspaceKey: 'ctrl-h',
      enterKey: 'crlf',
      localEcho: true,
    });
  });
});

describe('backing up host icons', () => {
  it('keeps a host icon in the backup file and gives it back on restore', async () => {
    mockBackupSnapshot([], [
      {
        id: 'edge',
        kind: 'telnet',
        name: 'Edge',
        profile: { kind: 'telnet', host: 'edge.example.test', port: 23 },
        metadata: { profileId: 'edge', color: '#4285f4', icon: 'nokia', connectCount: 0 },
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T00:00:00.000Z',
      },
    ]);

    const document = await createBackupDocument();
    expect(document.data.savedHosts[0]?.metadata).toMatchObject({ color: '#4285f4', icon: 'nokia' });

    // Through the file as it is written and read back.
    const read = parseTransferDocument(JSON.stringify(document));
    apiFetchMock.mockReset();
    apiFetchMock
      .mockResolvedValueOnce({ hosts: [] })
      .mockResolvedValueOnce({ profiles: [] })
      .mockResolvedValue({});

    await expect(
      restoreImportedConnections(
        {
          sshHosts: [
            {
              alias: 'web',
              aliases: ['web'],
              options: { hostname: 'web.example.test' },
              metadata: { icon: 'ubuntu' },
            },
          ],
          savedHosts: read.data.savedHosts,
          hostOrder: [],
        },
        'replace',
      ),
    ).resolves.toEqual({ added: 2, updated: 0, skipped: 0 });

    const icons = apiFetchMock.mock.calls
      .filter(([route]) => route.endsWith('/metadata'))
      .map(([route, init]) => [
        route,
        typeof init?.body === 'string' ? JSON.parse(init.body).icon : undefined,
      ]);
    expect(icons).toEqual([
      ['/api/ssh/config/hosts/web/metadata', 'ubuntu'],
      ['/api/profiles/edge/metadata', 'nokia'],
    ]);
  });
});

describe('backing up the algorithm lists of saved SSH hosts', () => {
  const routeServer: SavedHostProfile = {
    id: 'route-server',
    kind: 'ssh',
    name: 'Route server',
    profile: {
      kind: 'ssh',
      profileId: 'route-server',
      target: 'route-server.example.test',
      useConfig: false,
      kexAlgorithms: '+diffie-hellman-group14-sha1',
      hostKeyAlgorithms: '+ssh-rsa',
    },
    metadata: { profileId: 'route-server', connectCount: 0 },
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:00.000Z',
  };

  it('keeps them in the backup file and gives them back on restore', async () => {
    mockBackupSnapshot([], [routeServer]);
    const document = await createBackupDocument();

    const read = parseTransferDocument(JSON.stringify(document));
    apiFetchMock.mockReset();
    apiFetchMock
      .mockResolvedValueOnce({ hosts: [] })
      .mockResolvedValueOnce({ profiles: [] })
      .mockResolvedValue({});
    await restoreImportedConnections(
      { sshHosts: [], savedHosts: read.data.savedHosts, hostOrder: [] },
      'replace',
    );

    const body = apiFetchMock.mock.calls.find(
      ([route, init]) => route === '/api/profiles' && init?.method === 'PUT',
    )?.[1]?.body;
    if (typeof body !== 'string') throw new Error('the host was not restored');
    expect(JSON.parse(body).profile).toMatchObject({
      kexAlgorithms: '+diffie-hellman-group14-sha1',
      hostKeyAlgorithms: '+ssh-rsa',
    });
  });

  it('writes them as option lines in an OpenSSH export', async () => {
    const previews: HostUpsertRequest[] = [];
    apiFetchMock.mockImplementation(async (url, options) => {
      if (url === '/api/ssh/config') return { hosts: [] } as never;
      if (url === '/api/profiles') return { profiles: [routeServer] } as never;
      if (url === '/api/folders/settings') return { folders: [] } as never;
      if (url === '/api/ssh/config/preview') {
        if (typeof options?.body !== 'string') throw new Error('preview body was not JSON');
        previews.push(JSON.parse(options.body) as HostUpsertRequest);
        return { text: 'Host Route-server' } as never;
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await createOpenSshExport();

    expect(previews[0]?.options.extras).toEqual([
      { keyword: 'KexAlgorithms', value: '+diffie-hellman-group14-sha1' },
      { keyword: 'HostKeyAlgorithms', value: '+ssh-rsa' },
    ]);
  });
});

describe('which settings a backup carries', () => {
  // The two that belong to one computer. A setting in neither list does not compile.
  const LOCAL = ['interfaceZoom', 'debugMode'];
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('places every setting in a backup or names it as staying on this computer', () => {
    const settings = Object.keys(usePrefsStore.getInitialState()).filter((key) => key !== 'set');
    expect([...PREFERENCE_KEYS, ...LOCAL].sort()).toEqual(settings.sort());
    expect(PREFERENCE_KEYS.filter((key) => LOCAL.includes(key))).toEqual([]);
  });

  it('brings back every setting it carries', async () => {
    usePrefsStore.setState(usePrefsStore.getInitialState());
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(Object.keys(document.data.preferences)).toEqual([...PREFERENCE_KEYS]);
    // A setting that is written but has no check on the way back would be lost here.
    expect(Object.keys(sanitizePreferences(document.data.preferences)).sort()).toEqual(
      [...PREFERENCE_KEYS].sort(),
    );
  });

  it('keeps shortcuts, connection behavior, X11 and the host monitor', async () => {
    const chosen = {
      keybindings: { 'app.quick-launcher': ['Mod+J'], 'app.sidebar': [] },
      discoverEnvironments: false,
      environmentRefreshSeconds: 60,
      autoReconnectRemote: false,
      sshKeepaliveIntervalSeconds: 45,
      restoreScrollback: false,
      splitInheritsSession: false,
      tabNumberVisibility: 'always' as const,
      x11Enabled: true,
      x11ForwardByDefault: null,
      x11ClipboardSharing: true,
      monitorIntervalMs: 10_000,
      monitorKeptHosts: ['ssh:web-01', 'profile:edge'],
      environmentsPanelWidth: 520,
    };
    usePrefsStore.setState(chosen);
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences).toMatchObject(chosen);
    expect(sanitizePreferences(document.data.preferences)).toMatchObject(chosen);
  });

  it('keeps what stays on this computer out of the file', async () => {
    usePrefsStore.setState({ interfaceZoom: 1.25, debugMode: true });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences).not.toHaveProperty('interfaceZoom');
    expect(document.data.preferences).not.toHaveProperty('debugMode');
  });

  it('drops a malformed value and keeps the rest', () => {
    const restored = sanitizePreferences(
      prefs({
        keybindings: { 'app.sidebar': 'Mod+B' },
        sshKeepaliveIntervalSeconds: -5,
        environmentRefreshSeconds: 7,
        tabNumberVisibility: 'sometimes',
        x11Enabled: 'yes',
        monitorIntervalMs: 1,
        monitorKeptHosts: [42],
        environmentsPanelWidth: 12,
        restoreScrollback: false,
      }),
    );

    expect(restored).toEqual({ restoreScrollback: false });
  });
});

describe('backing up password managers and the links to their entries', () => {
  const ref = { sourceId: 'kp', entryId: 'entry-1', title: 'Edge router', username: 'admin' };

  it('writes where a manager is, under its own ID, and nothing about its state', async () => {
    mockBackupSnapshot(
      [],
      [
        {
          id: 'edge',
          kind: 'telnet',
          name: 'Edge',
          profile: { kind: 'telnet', host: 'edge.example.test', port: 23 },
          metadata: { profileId: 'edge', passwordRef: ref, connectCount: 0 },
          createdAt: '2026-11-22T00:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        },
        {
          id: 'plain',
          kind: 'telnet',
          name: 'Plain',
          profile: { kind: 'telnet', host: 'plain.example.test', port: 23 },
          metadata: { profileId: 'plain', connectCount: 0 },
          createdAt: '2026-11-22T00:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        },
      ],
      [],
      [],
      {
        passwordManagers: [
          {
            id: 'kp',
            kind: 'keepass',
            name: 'Work',
            config: { path: '/home/test/work.kdbx' },
            state: 'locked',
            message: 'Locked.',
            createdAt: '2026-11-22T00:00:00.000Z',
            updatedAt: '2026-11-22T00:00:00.000Z',
          },
        ],
      },
    );

    const document = await createBackupDocument();

    expect(document.data.passwordManagers).toEqual([
      { id: 'kp', kind: 'keepass', name: 'Work', config: { path: '/home/test/work.kdbx' } },
    ]);
    expect(document.data.savedHosts.map((host) => host.metadata.passwordRef)).toEqual([ref, null]);
  });

  const withManager = (metadata: Record<string, unknown>) => ({
    format: BACKUP_FORMAT,
    version: TRANSFER_VERSION,
    createdAt: '2026-11-22T12:00:00.000Z',
    data: {
      sshHosts: [],
      savedHosts: [
        {
          id: 'edge',
          name: 'Edge',
          profile: { kind: 'telnet', host: 'edge.example.test', port: 23 },
          metadata,
        },
      ],
      hostOrder: [],
      preferences: {},
      tunnels: [],
      loggingPolicies: [],
      historySettings: { maxTotalBytes: 1, minFreeBytes: 1, minFreePercent: 1 },
      passwordManagers: [
        { id: 'kp', kind: 'keepass', name: 'Work', config: { path: '/home/test/work.kdbx' } },
        { id: 'next', kind: 'a-manager-of-a-later-release', name: 'Later', config: {} },
      ],
    },
  });
  const connectionsOnly = {
    preferences: false,
    connections: true,
    tunnels: false,
    logging: false,
    workspaces: false,
    library: false,
  };
  const body = (call: unknown[]): unknown => JSON.parse(String((call[1] as { body: string }).body));

  it('connects a missing manager under its ID before the hosts that point at it', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ sources: [], installed: [] })
      .mockResolvedValue({ hosts: [], profiles: [], folders: [], sources: [] });

    const result = await restoreTransferDocument(
      parseTransferDocument(JSON.stringify(withManager({ passwordRef: ref }))),
      connectionsOnly,
      'keep',
    );

    // One manager and one host added; the manager this release does not know is left out.
    expect(result).toEqual({ added: 2, updated: 0, skipped: 1 });
    const calls = apiFetchMock.mock.calls;
    expect(calls[1]?.[0]).toBe('/api/password-managers');
    expect(calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(body(calls[1]!)).toEqual({
      id: 'kp',
      kind: 'keepass',
      name: 'Work',
      config: { path: '/home/test/work.kdbx' },
    });
    const patch = calls.find(([route]) => route === '/api/profiles/edge/metadata');
    expect(body(patch!)).toMatchObject({ passwordRef: ref });
  });

  it('keeps a connected manager, or updates it when replacing', async () => {
    const connected = { sources: [{ id: 'kp', kind: 'keepass', name: 'Mine', config: {} }], installed: [] };
    apiFetchMock
      .mockResolvedValueOnce(connected)
      .mockResolvedValue({ hosts: [], profiles: [{ id: 'edge' }], folders: [], sources: [] });
    const document = parseTransferDocument(JSON.stringify(withManager({})));

    await expect(restoreTransferDocument(document, connectionsOnly, 'keep')).resolves.toEqual({
      added: 0,
      updated: 0,
      skipped: 3,
    });
    expect(apiFetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);

    apiFetchMock.mockReset();
    apiFetchMock
      .mockResolvedValueOnce(connected)
      .mockResolvedValue({ hosts: [], profiles: [{ id: 'edge' }], folders: [], sources: [] });
    await restoreTransferDocument(document, connectionsOnly, 'replace');

    const update = apiFetchMock.mock.calls.find(([route]) => route === '/api/password-managers/kp');
    expect(update?.[1]).toMatchObject({ method: 'PUT' });
    expect(body(update!)).toEqual({ kind: 'keepass', name: 'Work', config: { path: '/home/test/work.kdbx' } });
  });

  it('takes a link away only when the file says the host has none', async () => {
    const patchFor = async (metadata: Record<string, unknown>) => {
      apiFetchMock.mockReset();
      apiFetchMock
        .mockResolvedValueOnce({ sources: [], installed: [] })
        .mockResolvedValue({ hosts: [], profiles: [], folders: [], sources: [] });
      await restoreTransferDocument(
        parseTransferDocument(JSON.stringify(withManager(metadata))),
        connectionsOnly,
        'replace',
      );
      return body(apiFetchMock.mock.calls.find(([route]) => route === '/api/profiles/edge/metadata')!);
    };

    expect(await patchFor({ passwordRef: null })).toMatchObject({ passwordRef: null });
    // A backup from before the links were kept, and a malformed one, leave the host's link alone.
    expect(await patchFor({})).not.toHaveProperty('passwordRef');
    expect(await patchFor({ passwordRef: { sourceId: 'kp' } })).not.toHaveProperty('passwordRef');
  });
});

describe('backing up workspaces, scripts and saved requests', () => {
  const layout = {
    version: 1 as const,
    root: {
      id: 'pane-1',
      type: 'pane' as const,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          kind: 'terminal' as const,
          title: 'web-01',
          profile: { kind: 'ssh' as const, target: 'web-01' },
          offerReconnect: true,
        },
      ],
    },
  };
  const workspace = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `Workspace ${id}`,
    layout,
    multiExecGroups: [],
    isLocked: false,
    isStartup: false,
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:00.000Z',
    lastOpenedAt: '2026-11-22T10:00:00.000Z',
    ...extra,
  });
  const script = { id: 's1', name: 'uptime', body: 'uptime\n' };
  const request = { id: 'r1', protocol: 'gnmi', profileId: 'leaf', name: 'interfaces', request: { path: '/interfaces' } };
  const stamps = { createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z' };

  const backup = (data: Record<string, unknown>) => ({
    format: BACKUP_FORMAT,
    version: TRANSFER_VERSION,
    createdAt: '2026-11-22T12:00:00.000Z',
    data: {
      sshHosts: [],
      savedHosts: [],
      hostOrder: [],
      preferences: {},
      tunnels: [],
      loggingPolicies: [],
      historySettings: { maxTotalBytes: 1, minFreeBytes: 1, minFreePercent: 1 },
      ...data,
    },
  });
  const only = (selected: 'workspaces' | 'library') => ({
    preferences: false,
    connections: false,
    tunnels: false,
    logging: false,
    workspaces: selected === 'workspaces',
    library: selected === 'library',
  });
  const body = (call: unknown[]): Record<string, unknown> =>
    JSON.parse(String((call[1] as { body: string }).body));

  it('writes every workspace in full, every script and every saved request', async () => {
    mockBackupSnapshot([], [], [], [], {
      workspaces: [workspace('a', { isLocked: true, isStartup: true }), workspace('b')],
      scripts: [{ ...script, ...stamps }],
      requests: [{ ...request, ...stamps }, { id: 'r2', protocol: 'netconf', name: 'running', request: {}, ...stamps }],
    });

    const document = await createBackupDocument();

    expect(document.data.workspaces).toEqual([
      { id: 'a', name: 'Workspace a', layout, multiExecGroups: [], isLocked: true, isStartup: true },
      { id: 'b', name: 'Workspace b', layout, multiExecGroups: [], isLocked: false, isStartup: false },
    ]);
    expect(document.data.scripts).toEqual([script]);
    expect(document.data.managementRequests).toEqual([
      request,
      { id: 'r2', protocol: 'netconf', name: 'running', request: {} },
    ]);
    // The file reads back as it was written.
    expect(parseTransferDocument(JSON.stringify(document)).data.workspaces).toHaveLength(2);
  });

  it('keeps a tiled workspace tiling through a backup and back', async () => {
    const tiled = workspace('a', { layout: { ...layout, tiling: 'rows' } });
    mockBackupSnapshot([], [], [], [], { workspaces: [tiled] });
    const document = parseTransferDocument(JSON.stringify(await createBackupDocument()));
    expect(document.data.workspaces?.[0]?.layout).toMatchObject({ tiling: 'rows' });

    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValueOnce({ workspaces: [] }).mockResolvedValueOnce(tiled).mockResolvedValue({});
    await restoreTransferDocument(document, only('workspaces'), 'keep');

    expect(body(apiFetchMock.mock.calls[1]!)).toMatchObject({ layout: { tiling: 'rows' } });
  });

  it('adds missing workspaces with their lock and the startup choice', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ workspaces: [] })
      .mockResolvedValueOnce(workspace('a'))
      .mockResolvedValue({});
    const document = parseTransferDocument(
      JSON.stringify(backup({ workspaces: [{ ...workspace('a'), isLocked: true, isStartup: true }] })),
    );

    await expect(restoreTransferDocument(document, only('workspaces'), 'keep')).resolves.toEqual({
      added: 1,
      updated: 0,
      skipped: 0,
    });

    const calls = apiFetchMock.mock.calls;
    expect(calls[1]?.[0]).toBe('/api/workspaces');
    expect(body(calls[1]!)).toEqual({
      id: 'a',
      name: 'Workspace a',
      layout,
      multiExecGroups: [],
      createIfMissing: true,
    });
    expect([calls[2]?.[0], body(calls[2]!)]).toEqual(['/api/workspaces/a', { isLocked: true }]);
    expect([calls[3]?.[0], body(calls[3]!)]).toEqual(['/api/workspaces/startup', { id: 'a' }]);
  });

  it('keeps an existing workspace, or writes over it and its name when replacing', async () => {
    const existing = { workspaces: [workspace('a', { name: 'Mine', isLocked: true, isStartup: true }), workspace('z', { isStartup: false })] };
    const document = parseTransferDocument(JSON.stringify(backup({ workspaces: [workspace('a')] })));

    apiFetchMock.mockResolvedValueOnce(existing);
    await expect(restoreTransferDocument(document, only('workspaces'), 'keep')).resolves.toEqual({
      added: 0,
      updated: 0,
      skipped: 1,
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    apiFetchMock.mockReset();
    apiFetchMock
      .mockResolvedValueOnce(existing)
      // The server keeps the name a workspace has when it is saved over.
      .mockResolvedValueOnce(workspace('a', { name: 'Mine', isLocked: true }))
      .mockResolvedValue({});
    await expect(restoreTransferDocument(document, only('workspaces'), 'replace')).resolves.toEqual({
      added: 0,
      updated: 1,
      skipped: 0,
    });
    const calls = apiFetchMock.mock.calls;
    expect(body(calls[1]!)).toMatchObject({ id: 'a', overwriteLocked: true });
    expect(body(calls[1]!)).not.toHaveProperty('createIfMissing');
    expect(calls.slice(2).map((call) => [call[0], body(call)])).toEqual([
      ['/api/workspaces/a', { name: 'Workspace a' }],
      ['/api/workspaces/a', { isLocked: false }],
    ]);
  });

  it('leaves out a workspace the server does not take and restores the others', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ workspaces: [] })
      .mockRejectedValueOnce(new Error('invalid workspace'))
      .mockResolvedValueOnce(workspace('b'));
    const document = parseTransferDocument(
      JSON.stringify(backup({ workspaces: [workspace('a'), workspace('b')] })),
    );

    await expect(restoreTransferDocument(document, only('workspaces'), 'replace')).resolves.toEqual({
      added: 1,
      updated: 0,
      skipped: 1,
    });
  });

  it('adds missing scripts and requests and keeps or replaces the ones that exist', async () => {
    const document = parseTransferDocument(
      JSON.stringify(backup({ scripts: [script, { id: 's2', name: 'df', body: 'df -h' }], managementRequests: [request] })),
    );

    apiFetchMock
      .mockResolvedValueOnce({ scripts: [{ id: 's1' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ requests: [{ id: 'r1' }] });
    await expect(restoreTransferDocument(document, only('library'), 'keep')).resolves.toEqual({
      added: 1,
      updated: 0,
      skipped: 2,
    });
    expect(body(apiFetchMock.mock.calls[1]!)).toEqual({ id: 's2', name: 'df', body: 'df -h' });

    apiFetchMock.mockReset();
    apiFetchMock
      .mockResolvedValueOnce({ scripts: [{ id: 's1' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ requests: [{ id: 'r1' }] })
      .mockResolvedValueOnce({});
    await expect(restoreTransferDocument(document, only('library'), 'replace')).resolves.toEqual({
      added: 1,
      updated: 2,
      skipped: 0,
    });
    expect(apiFetchMock.mock.calls[4]?.[0]).toBe('/api/management/requests');
    expect(body(apiFetchMock.mock.calls[4]!)).toEqual(request);
  });

  it('restores nothing of a part that is not selected, and reads a backup without these parts', async () => {
    const document = parseTransferDocument(
      JSON.stringify(backup({ workspaces: [workspace('a')], scripts: [script], managementRequests: [request] })),
    );
    await restoreTransferDocument(
      document,
      { preferences: false, connections: false, tunnels: false, logging: false, workspaces: false, library: false },
      'replace',
    );
    expect(apiFetchMock).not.toHaveBeenCalled();

    const older = parseTransferDocument(JSON.stringify(backup({})));
    await expect(restoreTransferDocument(older, only('workspaces'), 'replace')).resolves.toEqual({
      added: 0,
      updated: 0,
      skipped: 0,
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed or repeated entries before a restore can write', () => {
    const parse = (data: Record<string, unknown>) => () => parseTransferDocument(JSON.stringify(backup(data)));

    expect(parse({ workspaces: [{ id: 'a', name: 'A' }] })).toThrow('incomplete or too large');
    expect(parse({ scripts: [{ id: 's1', name: 'x' }] })).toThrow('incomplete or too large');
    expect(parse({ managementRequests: [{ ...request, protocol: 'snmp' }] })).toThrow('incomplete or too large');
    expect(parse({ passwordManagers: [{ id: 'kp', kind: 'keepass', name: 'Work' }] })).toThrow('incomplete or too large');
    expect(parse({ workspaces: [workspace('a'), workspace('a')] })).toThrow('duplicate saved items');
    expect(parse({ scripts: [script, script] })).toThrow('duplicate saved items');
  });
});

describe('exporting Muxus-only SSH hosts to OpenSSH', () => {
  it('materializes non-secret folder defaults and marks an omitted folder password', async () => {
    const previews: HostUpsertRequest[] = [];
    apiFetchMock.mockImplementation(async (url, options) => {
      if (url === '/api/ssh/config') return { hosts: [] } as never;
      if (url === '/api/profiles') {
        return {
          profiles: [
            {
              id: 'saved-1',
              kind: 'ssh',
              name: 'Core router',
              profile: {
                kind: 'ssh',
                profileId: 'saved-1',
                target: 'router.example.test',
                useConfig: false,
                user: 'profile-user',
              },
              metadata: {
                profileId: 'saved-1',
                group: 'Prod/EU',
                connectCount: 0,
              },
              createdAt: '2026-08-07T00:00:00.000Z',
              updatedAt: '2026-08-07T00:00:00.000Z',
            },
          ],
        } as never;
      }
      if (url === '/api/folders/settings') {
        return {
          folders: [
            {
              id: 'prod',
              path: 'Prod',
              auth: {
                user: 'folder-user',
                identityFiles: ['~/.ssh/prod'],
                identityAgent: 'SSH_AUTH_SOCK',
              },
              hasPassword: true,
              createdAt: '2026-08-07T00:00:00.000Z',
              updatedAt: '2026-08-07T00:00:00.000Z',
            },
            {
              id: 'prod-eu',
              path: 'Prod/EU',
              auth: { port: 2222 },
              hasPassword: false,
              createdAt: '2026-08-07T00:00:00.000Z',
              updatedAt: '2026-08-07T00:00:00.000Z',
            },
          ],
        } as never;
      }
      if (url === '/api/ssh/config/preview') {
        if (typeof options?.body !== 'string') throw new Error('preview body was not JSON');
        const request = JSON.parse(options.body) as HostUpsertRequest;
        previews.push(request);
        return { text: `Host ${request.aliases[0]}` } as never;
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(createOpenSshExport()).resolves.toContain('Host Core-router');
    expect(previews).toEqual([
      expect.objectContaining({
        aliases: ['Core-router'],
        description:
          'Exported from Muxus app data. Shared folder password omitted.',
        options: expect.objectContaining({
          hostname: 'router.example.test',
          user: 'profile-user',
          port: 2222,
          identityFiles: ['~/.ssh/prod'],
          identityAgent: 'SSH_AUTH_SOCK',
        }),
      }),
    ]);
  });
});

describe('exporting Muxus jump hosts to OpenSSH', () => {
  function savedSsh(
    id: string,
    name: string,
    profile: Omit<Extract<SavedHostProfile['profile'], { kind: 'ssh' }>, 'kind' | 'useConfig'>,
  ): SavedHostProfile {
    return {
      id,
      kind: 'ssh',
      name,
      profile: { kind: 'ssh', useConfig: false, profileId: id, ...profile },
      metadata: { profileId: id, connectCount: 0 },
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    };
  }

  it('points ProxyJump at the exported block of a saved jump host', async () => {
    const previews: HostUpsertRequest[] = [];
    apiFetchMock.mockImplementation(async (url, options) => {
      if (url === '/api/ssh/config') return { hosts: [] } as never;
      if (url === '/api/profiles') {
        return {
          profiles: [
            // Listed before the jump host it names, whose alias it still needs.
            savedSsh('app', 'App', {
              target: 'app.internal',
              proxyJump: [savedHostHop('bastion'), 'edge', savedHostHop('deleted')],
            }),
            savedSsh('bastion', 'Bastion EU', {
              target: 'bastion.example.test',
              user: 'jump',
              identityFiles: ['~/.ssh/bastion'],
            }),
          ],
        } as never;
      }
      if (url === '/api/folders/settings') return { folders: [] } as never;
      if (url === '/api/ssh/config/preview') {
        if (typeof options?.body !== 'string') throw new Error('preview body was not JSON');
        const request = JSON.parse(options.body) as HostUpsertRequest;
        previews.push(request);
        return { text: `Host ${request.aliases[0]}` } as never;
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await createOpenSshExport();

    expect(previews.map((request) => [request.aliases, request.options.proxyJump])).toEqual([
      [['App'], ['Bastion-EU', 'edge']],
      [['Bastion-EU'], undefined],
    ]);
  });
});

describe('restoring SSH hosts', () => {
  const importedSecondaryAlias = {
    sshHosts: [
      {
        alias: 'prod-alt',
        aliases: ['prod-alt'],
        options: { hostname: 'new.example.com' },
      },
    ],
    savedHosts: [],
    hostOrder: [],
  };

  it('keeps a host when an imported alias matches one of its secondary aliases', async () => {
    mockExistingMultiAliasHost();

    await expect(
      restoreImportedConnections(importedSecondaryAlias, 'keep'),
    ).resolves.toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the owning primary alias when replacing through a secondary alias', async () => {
    mockExistingMultiAliasHost();
    apiFetchMock.mockResolvedValueOnce({ file: '/home/test/.ssh/config' });

    await expect(
      restoreImportedConnections(importedSecondaryAlias, 'replace'),
    ).resolves.toEqual({ added: 0, updated: 1, skipped: 0 });

    expect(apiFetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/ssh/config/hosts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          aliases: ['prod-alt'],
          options: { hostname: 'new.example.com' },
          previousAlias: 'production',
          file: '/home/test/.ssh/config',
        }),
      }),
    );
  });
});

describe('restoring imported serial hosts', () => {
  const importedSerial = {
    sshHosts: [],
    savedHosts: [
      {
        id: 'securecrt-serial-console',
        name: 'Rack console',
        profile: {
          kind: 'serial' as const,
          path: '/dev/ttyUSB0',
          baudRate: 115200,
          dataBits: 8 as const,
          stopBits: 1 as const,
          parity: 'none' as const,
          flowControl: 'none' as const,
        },
        metadata: {
          group: 'Lab',
          terminalScheme: 'nord',
          terminalFontColor: '#eceff4',
          terminalBackgroundColor: '#2e3440',
        },
      },
    ],
    hostOrder: [],
  };

  it('keeps a native profile with the same deterministic import ID', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ hosts: [] })
      .mockResolvedValueOnce({ profiles: [{ id: 'securecrt-serial-console' }] });

    await expect(
      restoreImportedConnections(importedSerial, 'keep'),
    ).resolves.toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('upserts and organizes a selected serial profile', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ hosts: [] })
      .mockResolvedValueOnce({ profiles: [] })
      .mockResolvedValueOnce({ id: 'securecrt-serial-console' })
      .mockResolvedValueOnce({ id: 'securecrt-serial-console' });

    await expect(
      restoreImportedConnections(importedSerial, 'replace'),
    ).resolves.toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/profiles',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          id: 'securecrt-serial-console',
          name: 'Rack console',
          profile: importedSerial.savedHosts[0]?.profile,
        }),
      }),
    );
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/profiles/securecrt-serial-console/metadata',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          displayName: null,
          group: 'Lab',
          color: null,
          icon: null,
          terminalScheme: 'nord',
          terminalFontColor: '#eceff4',
          terminalBackgroundColor: '#2e3440',
          keywordHighlights: null,
          commandButtonGroup: null,
          pasteLineDelayMs: null,
          pasteCharDelayMs: null,
          pastePromptWait: null,
          antiIdle: null,
          backspaceKey: null,
          enterKey: null,
          implicitCr: false,
          localEcho: false,
          disableSftp: false,
          consoleCompatibility: false,
          systemOpenSsh: false,
          discoverEnvironments: null,
          loginSequence: null,
          proxyJumpFallbacks: null,
        }),
      }),
    );
  });

  it('restores prompt waiting, and drops a setting that does not check out', async () => {
    const restoredPromptWait = async (pastePromptWait: unknown) => {
      apiFetchMock.mockReset();
      apiFetchMock
        .mockResolvedValueOnce({ hosts: [] })
        .mockResolvedValueOnce({ profiles: [] })
        .mockResolvedValueOnce({ id: 'securecrt-serial-console' })
        .mockResolvedValueOnce({ id: 'securecrt-serial-console' });
      const host = importedSerial.savedHosts[0]!;
      await restoreImportedConnections(
        {
          ...importedSerial,
          savedHosts: [{ ...host, metadata: { ...host.metadata, pastePromptWait } as never }],
        },
        'replace',
      );
      const patch = apiFetchMock.mock.calls[3]?.[1]?.body as string;
      return (JSON.parse(patch) as { pastePromptWait: unknown }).pastePromptWait;
    };
    const own = { promptPattern: '[>#\\]]\\s*$', timeoutMs: 20_000 };

    expect(await restoredPromptWait(own)).toEqual(own);
    expect(await restoredPromptWait({})).toEqual({});
    expect(await restoredPromptWait({ promptPattern: '([' })).toBeNull();
    expect(await restoredPromptWait({ errorPattern: '' })).toBeNull();
    expect(await restoredPromptWait({ timeoutMs: 10 })).toBeNull();
    expect(await restoredPromptWait([])).toBeNull();
  });

  it('restores anti-idle, and drops a setting that does not check out', async () => {
    const restoredAntiIdle = async (antiIdle: unknown) => {
      apiFetchMock.mockReset();
      apiFetchMock
        .mockResolvedValueOnce({ hosts: [] })
        .mockResolvedValueOnce({ profiles: [] })
        .mockResolvedValueOnce({ id: 'securecrt-serial-console' })
        .mockResolvedValueOnce({ id: 'securecrt-serial-console' });
      const host = importedSerial.savedHosts[0]!;
      await restoreImportedConnections(
        { ...importedSerial, savedHosts: [{ ...host, metadata: { ...host.metadata, antiIdle } as never }] },
        'replace',
      );
      const patch = apiFetchMock.mock.calls[3]?.[1]?.body as string;
      return (JSON.parse(patch) as { antiIdle: unknown }).antiIdle;
    };
    const space = { intervalSeconds: 120, text: ' ', enter: false };

    expect(await restoredAntiIdle(space)).toEqual(space);
    expect(await restoredAntiIdle({ intervalSeconds: 1, text: ' ', enter: false })).toBeNull();
    expect(await restoredAntiIdle({ intervalSeconds: 120, text: '', enter: false })).toBeNull();
    // A hidden Enter or Ctrl+C in the text is not restored.
    expect(await restoredAntiIdle({ intervalSeconds: 120, text: 'a\rb\u0003', enter: false })).toBeNull();
  });

  it('restores keys and echo, and drops values this release does not know', async () => {
    const restoredModes = async (modes: Record<string, unknown>) => {
      apiFetchMock.mockReset();
      apiFetchMock
        .mockResolvedValueOnce({ hosts: [] })
        .mockResolvedValueOnce({ profiles: [] })
        .mockResolvedValueOnce({ id: 'securecrt-serial-console' })
        .mockResolvedValueOnce({ id: 'securecrt-serial-console' });
      const host = importedSerial.savedHosts[0]!;
      await restoreImportedConnections(
        { ...importedSerial, savedHosts: [{ ...host, metadata: { ...host.metadata, ...modes } as never }] },
        'replace',
      );
      const patch = JSON.parse(apiFetchMock.mock.calls[3]?.[1]?.body as string) as Record<string, unknown>;
      return {
        backspaceKey: patch.backspaceKey,
        enterKey: patch.enterKey,
        implicitCr: patch.implicitCr,
        localEcho: patch.localEcho,
      };
    };
    const modes = { backspaceKey: 'ctrl-h', enterKey: 'lf', implicitCr: true, localEcho: true };
    const defaults = { backspaceKey: null, enterKey: null, implicitCr: false, localEcho: false };

    expect(await restoredModes(modes)).toEqual(modes);
    expect(
      await restoredModes({ backspaceKey: 'bs', enterKey: '\r\n', implicitCr: 1, localEcho: 'yes' }),
    ).toEqual(defaults);
  });
});

describe('restoring Muxus-only SSH hosts', () => {
  const importedSsh = {
    sshHosts: [],
    savedHosts: [
      {
        id: 'mobaxterm-ssh-router',
        name: 'Core router',
        profile: {
          kind: 'ssh' as const,
          target: 'router.example.test',
          useConfig: false as const,
          user: 'admin',
          passwordOnly: true,
        },
        metadata: { group: 'Lab' },
      },
    ],
    hostOrder: [],
  };

  it('restores through the native profile endpoint rather than ssh_config', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ hosts: [] })
      .mockResolvedValueOnce({ profiles: [] })
      .mockResolvedValueOnce({ id: 'mobaxterm-ssh-router' })
      .mockResolvedValueOnce({ id: 'mobaxterm-ssh-router' });

    await expect(
      restoreImportedConnections(importedSsh, 'replace'),
    ).resolves.toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/profiles',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          id: 'mobaxterm-ssh-router',
          name: 'Core router',
          profile: importedSsh.savedHosts[0]?.profile,
        }),
      }),
    );
    expect(
      apiFetchMock.mock.calls.some(([url]) => url === '/api/ssh/config/hosts'),
    ).toBe(false);
  });
});

describe('restoring sidebar folder preferences', () => {
  /** Only the folder keys matter here; the rest of the shape is unvalidated. */
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores well-formed folder state', () => {
    const input = {
      sidebarCollapsedFolders: ['folder:prod', 'folder:prod/eu'],
      sidebarEmptyFolders: ['Staging/Blue'],
      sidebarFolderStyles: { 'folder:prod': { color: '#ef5350', icon: 'cloud' } },
    };

    expect(sanitizePreferences(prefs(input))).toMatchObject(input);
  });

  it('drops an oversized folder list rather than importing it', () => {
    const tooMany = Array.from({ length: 501 }, (_entry, index) => `folder:${index}`);
    const tooLong = ['x'.repeat(401)];

    expect(sanitizePreferences(prefs({ sidebarEmptyFolders: tooMany })).sidebarEmptyFolders)
      .toBeUndefined();
    expect(sanitizePreferences(prefs({ sidebarCollapsedFolders: tooLong })).sidebarCollapsedFolders)
      .toBeUndefined();
  });

  it('drops folder styles carrying a bad colour or an unknown icon', () => {
    expect(
      sanitizePreferences(prefs({ sidebarFolderStyles: { a: { color: 'red' } } }))
        .sidebarFolderStyles,
    ).toBeUndefined();
    expect(
      sanitizePreferences(prefs({ sidebarFolderStyles: { a: { icon: 'skull' } } }))
        .sidebarFolderStyles,
    ).toBeUndefined();
    expect(
      sanitizePreferences(prefs({ sidebarFolderStyles: { a: { icon: 'lab' } } }))
        .sidebarFolderStyles,
    ).toEqual({ a: { icon: 'lab' } });
  });
});

describe('restoring the font color preference', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores a hex override and the explicit scheme-default empty string', () => {
    expect(sanitizePreferences(prefs({ fontColor: '#AABB00' }))).toMatchObject({
      fontColor: '#AABB00',
    });
    expect(sanitizePreferences(prefs({ fontColor: '' }))).toMatchObject({ fontColor: '' });
  });

  it('drops a malformed font color rather than importing it', () => {
    expect(sanitizePreferences(prefs({ fontColor: 'red' })).fontColor).toBeUndefined();
    expect(sanitizePreferences(prefs({ fontColor: '#fff' })).fontColor).toBeUndefined();
    expect(sanitizePreferences(prefs({ fontColor: 42 })).fontColor).toBeUndefined();
  });
});

describe('restoring the background color preference', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores a hex override and the explicit scheme-default empty string', () => {
    expect(sanitizePreferences(prefs({ backgroundColor: '#102030' }))).toMatchObject({
      backgroundColor: '#102030',
    });
    expect(sanitizePreferences(prefs({ backgroundColor: '' }))).toMatchObject({
      backgroundColor: '',
    });
  });

  it('drops a malformed background color rather than importing it', () => {
    expect(sanitizePreferences(prefs({ backgroundColor: 'black' })).backgroundColor).toBeUndefined();
    expect(sanitizePreferences(prefs({ backgroundColor: '#000' })).backgroundColor).toBeUndefined();
    expect(sanitizePreferences(prefs({ backgroundColor: 42 })).backgroundColor).toBeUndefined();
  });
});

describe('restoring the OSC 52 clipboard preference', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores only boolean clipboard-write choices', () => {
    expect(sanitizePreferences(prefs({ allowOsc52ClipboardWrite: false })))
      .toMatchObject({ allowOsc52ClipboardWrite: false });
    expect(
      sanitizePreferences(prefs({ allowOsc52ClipboardWrite: 'yes' }))
        .allowOsc52ClipboardWrite,
    ).toBeUndefined();
  });
});

describe('restoring the close tab on clean exit preference', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores only boolean choices and leaves older backups at the default', () => {
    expect(sanitizePreferences(prefs({ closeTabOnCleanExit: true })))
      .toMatchObject({ closeTabOnCleanExit: true });
    expect(sanitizePreferences(prefs({ closeTabOnCleanExit: 1 })).closeTabOnCleanExit)
      .toBeUndefined();
    expect(sanitizePreferences(prefs({})).closeTabOnCleanExit).toBeUndefined();
  });
});

describe('restoring the look-alike paste preference', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores only boolean choices and leaves older backups at the default', () => {
    expect(sanitizePreferences(prefs({ pasteWarnLookalikes: false })))
      .toMatchObject({ pasteWarnLookalikes: false });
    expect(sanitizePreferences(prefs({ pasteWarnLookalikes: 'no' })).pasteWarnLookalikes)
      .toBeUndefined();
    expect(sanitizePreferences(prefs({})).pasteWarnLookalikes).toBeUndefined();
  });
});

describe('restoring the GPU renderer preference', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores only boolean renderer choices', () => {
    expect(sanitizePreferences(prefs({ webglRenderer: true })))
      .toMatchObject({ webglRenderer: true });
    expect(sanitizePreferences(prefs({ webglRenderer: 'off' })).webglRenderer).toBeUndefined();
  });
});

describe('restoring the update notification preference', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores only boolean notification choices', () => {
    expect(sanitizePreferences(prefs({ notifyOnNewVersion: false })))
      .toMatchObject({ notifyOnNewVersion: false });
    expect(
      sanitizePreferences(prefs({ notifyOnNewVersion: 'disabled' }))
        .notifyOnNewVersion,
    ).toBeUndefined();
  });
});

describe('restoring the command bar preference', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores only boolean visibility choices', () => {
    expect(sanitizePreferences(prefs({ showCommandBar: false })))
      .toMatchObject({ showCommandBar: false });
    expect(
      sanitizePreferences(prefs({ showCommandBar: 'hidden' })).showCommandBar,
    ).toBeUndefined();
  });
});

describe('restoring command button groups', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;
  const juniper = { id: 'juniper', name: 'Juniper' };
  const bgp = {
    id: 'bgp',
    label: 'BGP',
    command: 'show bgp summary',
    sendEnter: true,
    groupId: 'juniper',
    color: 'purple',
  };

  it('restores groups, the selected group, and each button in its group', () => {
    expect(
      sanitizePreferences(
        prefs({
          commandButtonGroups: [juniper],
          commandButtons: [bgp],
          selectedCommandButtonGroup: 'juniper',
        }),
      ),
    ).toMatchObject({
      commandButtonGroups: [{ id: 'default', name: 'Default' }, juniper],
      commandButtons: [bgp],
      selectedCommandButtonGroup: 'juniper',
    });
  });

  it('files buttons from a backup without groups under the default group', () => {
    const restored = sanitizePreferences(
      prefs({ commandButtons: [bgp], selectedCommandButtonGroup: 'juniper' }),
    );
    expect(restored.commandButtons).toEqual([
      { id: 'bgp', label: 'BGP', command: 'show bgp summary', sendEnter: true, color: 'purple' },
    ]);
    expect(restored.commandButtonGroups).toBeUndefined();
    expect(restored.selectedCommandButtonGroup).toBeUndefined();
  });

  it('restores button shortcuts, and buttons from backups made before them unbound', () => {
    const bound = { ...bgp, shortcut: 'Ctrl+Alt+KeyB' };
    expect(
      sanitizePreferences(prefs({ commandButtonGroups: [juniper], commandButtons: [bound] }))
        .commandButtons,
    ).toEqual([bound]);
    expect(
      sanitizePreferences(prefs({ commandButtonGroups: [juniper], commandButtons: [bgp] }))
        .commandButtons,
    ).toEqual([bgp]);
    expect(
      sanitizePreferences(
        prefs({ commandButtonGroups: [juniper], commandButtons: [{ ...bgp, shortcut: 'KeyB' }] }),
      ).commandButtons,
    ).toEqual([bgp]);
  });

  it('drops a malformed button without losing the rest', () => {
    expect(
      sanitizePreferences(prefs({ commandButtons: [{ id: 'x', command: 7 }, { ...bgp, groupId: undefined }] }))
        .commandButtons,
    ).toEqual([{ ...bgp, groupId: undefined }].map(({ groupId: _groupId, ...button }) => button));
  });
});

describe('restoring the layout preferences', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores the sidebar side and the command bar position', () => {
    expect(
      sanitizePreferences(prefs({ sidebarPosition: 'right', commandBarPosition: 'bottom' })),
    ).toMatchObject({ sidebarPosition: 'right', commandBarPosition: 'bottom' });
  });

  it('leaves out the file browser dock and width of older backups', () => {
    const restored = sanitizePreferences(
      prefs({ fileBrowserPosition: 'pane', sftpPanelWidth: 420, sidebarPosition: 'right' }),
    ) as Record<string, unknown>;
    expect(restored.sidebarPosition).toBe('right');
    expect(restored.fileBrowserPosition).toBeUndefined();
    expect(restored.sftpPanelWidth).toBeUndefined();
  });

  it('drops positions it does not know', () => {
    const restored = sanitizePreferences(
      prefs({ sidebarPosition: 'top', commandBarPosition: 'left' }),
    );
    expect(restored.sidebarPosition).toBeUndefined();
    expect(restored.commandBarPosition).toBeUndefined();
  });

  it('restores the status bar and its items, and drops items it does not know', () => {
    expect(
      sanitizePreferences(prefs({ showStatusBar: true, statusBarItems: ['uptime', 'users'] })),
    ).toMatchObject({ showStatusBar: true, statusBarItems: ['uptime', 'users'] });
    const restored = sanitizePreferences(
      prefs({ showStatusBar: 'on', statusBarItems: ['uptime', 'gpu'] }),
    );
    expect(restored.showStatusBar).toBeUndefined();
    expect(restored.statusBarItems).toBeUndefined();
  });

  it('restores how sidebar entries open, and drops a gesture it does not know', () => {
    expect(sanitizePreferences(prefs({ sidebarOpenGesture: 'double-click' }))).toMatchObject({
      sidebarOpenGesture: 'double-click',
    });
    expect(
      sanitizePreferences(prefs({ sidebarOpenGesture: 'hover' })).sidebarOpenGesture,
    ).toBeUndefined();
  });

  it('restores the sidebar and hosts tab layout, and drops what it does not know', () => {
    const layout = {
      sidebarRailPinned: true,
      sidebarHostView: 'list',
      sidebarHostGrouping: 'name',
      hostsTabView: 'table',
      hostsTabSort: { column: 'address', descending: true },
    };
    expect(sanitizePreferences(prefs(layout))).toMatchObject(layout);
    const unknown = sanitizePreferences(
      prefs({
        sidebarRailPinned: 1,
        sidebarHostView: 'grid',
        sidebarHostGrouping: 'size',
        hostsTabView: 'list',
        hostsTabSort: { column: 'owner', descending: true },
      }),
    );
    expect(unknown.sidebarRailPinned).toBeUndefined();
    expect(unknown.sidebarHostView).toBeUndefined();
    expect(unknown.sidebarHostGrouping).toBeUndefined();
    expect(unknown.hostsTabView).toBeUndefined();
    expect(unknown.hostsTabSort).toBeUndefined();
  });

  it('restores whether the file browser lists hidden files, and leaves older backups at the default', () => {
    expect(sanitizePreferences(prefs({ showHiddenFiles: false }))).toMatchObject({
      showHiddenFiles: false,
    });
    expect(sanitizePreferences(prefs({ showHiddenFiles: 'no' })).showHiddenFiles).toBeUndefined();
    expect(sanitizePreferences(prefs({})).showHiddenFiles).toBeUndefined();
  });
});

describe('restoring manual folder order', () => {
  const prefs = (patch: Record<string, unknown>) => patch as unknown as BackupPreferences;

  it('restores a well-formed order map', () => {
    const input = { sidebarFolderOrder: { root: ['folder:prod'], 'folder:prod': ['folder:prod/eu'] } };
    expect(sanitizePreferences(prefs(input))).toMatchObject(input);
  });

  it('drops an order map that is oversized or the wrong shape', () => {
    expect(
      sanitizePreferences(prefs({ sidebarFolderOrder: { root: [1, 2] } })).sidebarFolderOrder,
    ).toBeUndefined();
    const tooMany = Object.fromEntries(
      Array.from({ length: 501 }, (_entry, i) => [`folder:${i}`, []]),
    );
    expect(
      sanitizePreferences(prefs({ sidebarFolderOrder: tooMany })).sidebarFolderOrder,
    ).toBeUndefined();
  });
});

describe('backing up shared sessions links', () => {
  const link = {
    id: 'lab-link',
    name: 'Lab hosts',
    url: 'https://portal.example.net/me.mxtsessions',
    folder: 'Lab',
    refreshMinutes: 60,
  };

  it('keeps each link with its ID and leaves its status behind', async () => {
    mockBackupSnapshot([], [], [], [
      { ...link, hostCount: 12, lastSyncedAt: '2026-11-20T08:00:00.000Z', lastError: 'gone', createdAt: 'x', updatedAt: 'y' },
    ]);

    const document = await createBackupDocument();

    expect(document.data.sharedSessionSources).toEqual([link]);
    expect(parseTransferDocument(JSON.stringify(document)).data.sharedSessionSources).toEqual([link]);
  });

  it('restores links with the connections, keeping or replacing one that is already there', async () => {
    const backup = (sources: unknown[]) =>
      parseTransferDocument(
        JSON.stringify({
          format: 'muxus-backup',
          version: 2,
          createdAt: '2026-11-20T00:00:00.000Z',
          data: {
            sshHosts: [],
            savedHosts: [],
            hostOrder: [],
            preferences: {},
            tunnels: [],
            loggingPolicies: [],
            historySettings: { maxTotalBytes: 1, minFreeBytes: 0, minFreePercent: 0 },
            sharedSessionSources: sources,
          },
        }),
      );
    const restore = async (strategy: 'keep' | 'replace') => {
      apiFetchMock.mockReset();
      apiFetchMock.mockImplementation(async (url, init) => {
        if (url === '/api/ssh/config') return { hosts: [] } as never;
        if (url === '/api/profiles') return { profiles: [] } as never;
        if (url === '/api/shared-sessions' && !init?.method) return { sources: [{ id: 'lab-link' }] } as never;
        return {} as never;
      });
      const result = await restoreTransferDocument(
        backup([link, { ...link, id: 'new-link', name: 'New', hostCount: 3 }]),
        { preferences: false, connections: true, tunnels: false, logging: false, workspaces: false, library: false },
        strategy,
      );
      const puts = apiFetchMock.mock.calls
        .filter(([url, init]) => url === '/api/shared-sessions' && init?.method === 'PUT')
        .map(([, init]) => JSON.parse(init?.body as string) as unknown);
      return { result, puts };
    };

    const kept = await restore('keep');
    expect(kept.puts).toEqual([{ ...link, id: 'new-link', name: 'New' }]);
    expect(kept.result).toEqual({ added: 1, updated: 0, skipped: 1 });

    const replaced = await restore('replace');
    expect(replaced.puts).toEqual([link, { ...link, id: 'new-link', name: 'New' }]);
    expect(replaced.result).toEqual({ added: 1, updated: 1, skipped: 0 });
  });

  it('refuses a backup whose links are malformed', () => {
    expect(() =>
      parseTransferDocument(
        JSON.stringify({
          format: 'muxus-backup',
          version: 2,
          createdAt: '2026-11-20T00:00:00.000Z',
          data: {
            sshHosts: [],
            savedHosts: [],
            hostOrder: [],
            preferences: {},
            tunnels: [],
            loggingPolicies: [],
            historySettings: { maxTotalBytes: 1, minFreeBytes: 0, minFreePercent: 0 },
            sharedSessionSources: [{ ...link, refreshMinutes: -5 }],
          },
        }),
      ),
    ).toThrow('The backup data is incomplete or too large.');
  });
});
