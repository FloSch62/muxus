import { describe, expect, it } from 'vitest';
import type { SftpEntry } from '@muxus/shared';
import {
  DEFAULT_SFTP_SORT,
  nextSftpSort,
  sortedSftpEntries,
  type SftpSort,
} from '../../../client/src/sftp-sort.js';

const entry = (name: string, type: SftpEntry['type'], size?: number, mtimeMs?: number): SftpEntry => ({
  name,
  type,
  size,
  mtimeMs,
});

const LISTING = [
  entry('b.log', 'file', 300, 3_000),
  entry('logs', 'dir', 4096, 1_000),
  entry('a.txt', 'file', 10, 5_000),
  entry('current', 'link', 50, 4_000),
  entry('C.bin', 'file', 300, 2_000),
  entry('archive', 'dir', 64, 6_000),
];

const names = (sort: SftpSort, entries = LISTING) =>
  sortedSftpEntries(entries, sort).map((candidate) => candidate.name);

describe('sortedSftpEntries', () => {
  it('lists folders first, then names A to Z, by default', () => {
    expect(names(DEFAULT_SFTP_SORT)).toEqual(['archive', 'logs', 'a.txt', 'b.log', 'C.bin', 'current']);
  });

  it('reverses names within folders and files, folders still first', () => {
    expect(names({ key: 'name', descending: true })).toEqual([
      'logs',
      'archive',
      'current',
      'C.bin',
      'b.log',
      'a.txt',
    ]);
  });

  it('sorts files by size and folders by name, equal sizes by name', () => {
    expect(names({ key: 'size', descending: true })).toEqual([
      'archive',
      'logs',
      'b.log',
      'C.bin',
      'a.txt',
      'current',
    ]);
    expect(names({ key: 'size', descending: false })).toEqual([
      'archive',
      'logs',
      'current',
      'a.txt',
      'b.log',
      'C.bin',
    ]);
  });

  it('sorts folders and files by modification time, each on their own', () => {
    expect(names({ key: 'modified', descending: true })).toEqual([
      'archive',
      'logs',
      'a.txt',
      'current',
      'b.log',
      'C.bin',
    ]);
    expect(names({ key: 'modified', descending: false })).toEqual([
      'logs',
      'archive',
      'C.bin',
      'b.log',
      'current',
      'a.txt',
    ]);
  });

  it('ranks a missing size or time as the smallest', () => {
    const listing = [entry('upload.part', 'file'), entry('empty.txt', 'file', 0, 1_000)];
    expect(names({ key: 'size', descending: false }, listing)).toEqual(['upload.part', 'empty.txt']);
    expect(names({ key: 'modified', descending: true }, listing)).toEqual(['empty.txt', 'upload.part']);
  });

  it('leaves the listing it was given in place', () => {
    const before = LISTING.map((candidate) => candidate.name);
    names({ key: 'size', descending: true });
    expect(LISTING.map((candidate) => candidate.name)).toEqual(before);
  });
});

describe('nextSftpSort', () => {
  it('reverses the sorted column', () => {
    expect(nextSftpSort(DEFAULT_SFTP_SORT, 'name')).toEqual({ key: 'name', descending: true });
    expect(nextSftpSort({ key: 'size', descending: true }, 'size')).toEqual({ key: 'size', descending: false });
  });

  it('starts names at A and sizes and times at the largest and newest', () => {
    expect(nextSftpSort({ key: 'modified', descending: false }, 'name')).toEqual(DEFAULT_SFTP_SORT);
    expect(nextSftpSort(DEFAULT_SFTP_SORT, 'size')).toEqual({ key: 'size', descending: true });
    expect(nextSftpSort({ key: 'name', descending: true }, 'modified')).toEqual({
      key: 'modified',
      descending: true,
    });
  });
});
