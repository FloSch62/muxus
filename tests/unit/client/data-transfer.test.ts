import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  TRANSFER_VERSION,
  parseTransferDocument,
  sanitizePreferences,
  type BackupPreferences,
} from '../../../client/src/data-transfer.js';

const connections = {
  sshHosts: [
    {
      alias: 'production',
      aliases: ['production'],
      options: { hostname: 'prod.example.com', user: 'deploy' },
      metadata: { favorite: true, group: 'Work' },
    },
  ],
  savedHosts: [],
  hostOrder: [{ kind: 'ssh', alias: 'production' }],
};

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
