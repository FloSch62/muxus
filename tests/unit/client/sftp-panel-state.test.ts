import { describe, expect, it } from 'vitest';
import type { SftpEntry } from '@muxus/shared';
import {
  emptySftpListingLabel,
  initialSftpPath,
  visibleSftpEntries,
} from '../../../client/src/sftp-panel-state.js';

describe('SFTP panel state', () => {
  it('starts at the terminal directory only while following is enabled', () => {
    expect(initialSftpPath('.', '/srv/project', true)).toBe('/srv/project');
    expect(initialSftpPath('.', '/srv/project', false)).toBe('.');
  });

  it('falls back to the requested initial path before a terminal directory is reported', () => {
    expect(initialSftpPath('/uploads', undefined, true)).toBe('/uploads');
  });
});

const entry = (name: string, type: SftpEntry['type'] = 'file'): SftpEntry => ({ name, type });
const listing = [
  entry('.ssh', 'dir'),
  entry('logs', 'dir'),
  entry('.bashrc'),
  entry('Report.TXT'),
  entry('notes.txt'),
];

describe('visible SFTP entries', () => {
  const names = (entries: readonly SftpEntry[]) => entries.map((candidate) => candidate.name);

  it('lists every entry, dotfiles included, by default', () => {
    expect(visibleSftpEntries(listing, true, '')).toEqual(listing);
  });

  it('leaves out names starting with a dot while hidden files are hidden', () => {
    expect(names(visibleSftpEntries(listing, false, ''))).toEqual(['logs', 'Report.TXT', 'notes.txt']);
  });

  it('keeps names containing the filter, ignoring case, in listing order', () => {
    expect(names(visibleSftpEntries(listing, true, 'TXT'))).toEqual(['Report.TXT', 'notes.txt']);
    expect(names(visibleSftpEntries(listing, true, ' rep '))).toEqual(['Report.TXT']);
  });

  it('filters only the entries on show', () => {
    expect(visibleSftpEntries(listing, false, 'bash')).toEqual([]);
    expect(names(visibleSftpEntries(listing, true, 'bash'))).toEqual(['.bashrc']);
  });
});

describe('empty SFTP listing label', () => {
  it('tells an empty folder from a filter that matches nothing', () => {
    expect(emptySftpListingLabel([], '')).toBe('Empty directory');
    expect(emptySftpListingLabel([], 'log')).toBe('Empty directory');
    expect(emptySftpListingLabel(listing, 'zzz')).toBe('No files match');
  });

  it('says when only hidden files are left, or only hidden files match', () => {
    expect(emptySftpListingLabel([entry('.ssh', 'dir'), entry('.bashrc')], ' ')).toBe('Only hidden files');
    expect(emptySftpListingLabel(listing, 'BASH')).toBe('Only hidden files match');
  });
});
