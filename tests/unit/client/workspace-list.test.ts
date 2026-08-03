import { describe, expect, it } from 'vitest';
import type { WorkspaceSummary } from '@muxus/shared';
import { selectWorkspaces } from '../../../client/src/workspace-list.js';

function workspace(
  id: string,
  name: string,
  createdAt: string,
  updatedAt = createdAt,
  lastOpenedAt?: string,
): WorkspaceSummary {
  return {
    id,
    name,
    createdAt,
    updatedAt,
    lastOpenedAt,
    isLocked: false,
    isStartup: false,
  };
}

const catalog = [
  workspace('alpha', 'Lab 2', '2026-01-01', '2026-01-04'),
  workspace('beta', 'Lab 10', '2026-01-03', '2026-01-03', '2026-01-05'),
  workspace('gamma', 'Production', '2026-01-02', '2026-01-02'),
];

describe('workspace catalog selection', () => {
  it('searches names case-insensitively and sorts them naturally', () => {
    expect(selectWorkspaces(catalog, 'LAB', 'name').map(({ id }) => id)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('sorts by last activity and keeps the active workspace first', () => {
    expect(selectWorkspaces(catalog, '', 'recent', 'alpha').map(({ id }) => id)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('sorts newly created workspaces first without mutating the catalog', () => {
    const original = [...catalog];
    expect(selectWorkspaces(catalog, '', 'created').map(({ id }) => id)).toEqual([
      'beta',
      'gamma',
      'alpha',
    ]);
    expect(catalog).toEqual(original);
  });
});
