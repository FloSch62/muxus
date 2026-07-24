import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  TRANSFER_VERSION,
  parseTransferDocument,
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
