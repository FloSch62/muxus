import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../client/src/api/http.js';
import {
  BACKUP_FORMAT,
  TRANSFER_VERSION,
  parseTransferDocument,
  restoreImportedConnections,
  sanitizePreferences,
  type BackupPreferences,
} from '../../../client/src/data-transfer.js';

vi.mock('../../../client/src/api/http.js', () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  apiFetchMock.mockReset();
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
          version: 2,
          createdAt: '2026-07-24T12:00:00.000Z',
          data: {},
        }),
      ),
    ).toThrow('Muxus transfer version 2 is not supported.');
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
