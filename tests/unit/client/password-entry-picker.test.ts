import { describe, expect, it } from 'vitest';
import type { PasswordManagerEntry } from '@muxus/shared';
import { filterEntries } from '../../../client/src/components/password-managers/PasswordEntryPicker.js';

const entries: PasswordManagerEntry[] = [
  { id: '1', title: 'Core router', username: 'admin', group: 'Network / Core' },
  { id: '2', title: 'web1', username: 'root', url: 'ssh://web1.example.com', group: 'Servers' },
  { id: '3', title: 'WEB2', username: 'deploy', url: 'ssh://web2.example.com', group: 'Servers' },
];
const ids = (query: string) => filterEntries(entries, query).map((entry) => entry.id);

describe('filtering password-manager entries', () => {
  it('returns everything for an empty search', () => {
    expect(ids('')).toEqual(['1', '2', '3']);
    expect(ids('   ')).toEqual(['1', '2', '3']);
  });

  it('matches title, user name, address and group without regard to case', () => {
    expect(ids('web')).toEqual(['2', '3']);
    expect(ids('ADMIN')).toEqual(['1']);
    expect(ids('example.com')).toEqual(['2', '3']);
    expect(ids('network')).toEqual(['1']);
  });

  it('needs every word, in any field', () => {
    expect(ids('servers root')).toEqual(['2']);
    expect(ids('web deploy')).toEqual(['3']);
    expect(ids('router root')).toEqual([]);
  });
});
