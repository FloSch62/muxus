import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../client/src/api/http.js';
import type { HostUpsertRequest } from '@muxus/shared';
import {
  BACKUP_FORMAT,
  TRANSFER_VERSION,
  createBackupDocument,
  createOpenSshExport,
  parseTransferDocument,
  restoreImportedConnections,
  sanitizePreferences,
  type BackupPreferences,
} from '../../../client/src/data-transfer.js';
import { usePrefsStore } from '../../../client/src/state/prefs.js';

vi.mock('../../../client/src/api/http.js', () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  apiFetchMock.mockReset();
  usePrefsStore.setState({
    notifyOnNewVersion: true,
    showCommandBar: true,
    backgroundColor: '',
    lightTerminalScheme: 'vscode-light',
    darkTerminalScheme: 'vscode-dark',
    activePaneBorder: false,
    dimInactivePanes: false,
    inactivePaneDimStrength: 0.15,
    terminalFileLinkActivation: 'alt',
    localShellProfiles: [],
    defaultLocalShellProfileId: '',
    keywordHighlightProfiles: [],
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

function mockBackupSnapshot(folders: unknown[] = []): void {
  apiFetchMock
    .mockResolvedValueOnce({ hosts: [] })
    .mockResolvedValueOnce({ profiles: [] })
    .mockResolvedValueOnce({ tunnels: [] })
    .mockResolvedValueOnce({ overridden: false })
    .mockResolvedValueOnce({ overridden: false })
    .mockResolvedValueOnce({
      settings: {
        storageLocation: '/tmp/muxus-history',
        maxTotalBytes: 5 * 1024 ** 3,
        minFreeBytes: 2 * 1024 ** 3,
        minFreePercent: 5,
      },
    })
    .mockResolvedValueOnce({ folders });
}

describe('backing up preferences', () => {
  it('includes display and update-notification choices', async () => {
    usePrefsStore.setState({
      notifyOnNewVersion: false,
      showCommandBar: false,
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
    expect(document.data.preferences.lightTerminalScheme).toBe('paper');
    expect(document.data.preferences.darkTerminalScheme).toBe('dracula');
    expect(document.data.preferences.activePaneBorder).toBe(false);
    expect(document.data.preferences.dimInactivePanes).toBe(true);
    expect(document.data.preferences.inactivePaneDimStrength).toBe(0.35);
    expect(document.data.preferences.terminalFileLinkActivation).toBe('ctrl');
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
    });
    mockBackupSnapshot();

    const document = await createBackupDocument();

    expect(document.data.preferences.localShellProfiles).toHaveLength(1);
    expect(document.data.preferences.defaultLocalShellProfileId).toBe('ubuntu');
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
        metadata: { group: 'Lab' },
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
          keywordHighlights: null,
          disableSftp: false,
          consoleCompatibility: false,
        }),
      }),
    );
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
