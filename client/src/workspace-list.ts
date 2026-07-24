import type { WorkspaceSummary } from '@muxus/shared';

export type WorkspaceSort = 'recent' | 'name' | 'created';

function compareNames(left: WorkspaceSummary, right: WorkspaceSummary): number {
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function compareNewest(
  left: WorkspaceSummary,
  right: WorkspaceSummary,
  timestamp: (workspace: WorkspaceSummary) => string,
): number {
  const newestFirst = timestamp(right).localeCompare(timestamp(left));
  return newestFirst || compareNames(left, right);
}

/** Filter and sort a catalog without mutating the backend-owned order. */
export function selectWorkspaces(
  workspaces: readonly WorkspaceSummary[],
  query: string,
  sort: WorkspaceSort,
  activeId?: string,
): WorkspaceSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = normalizedQuery
    ? workspaces.filter((workspace) =>
        workspace.name.toLocaleLowerCase().includes(normalizedQuery),
      )
    : [...workspaces];

  return visible.sort((left, right) => {
    if (left.id === activeId) return -1;
    if (right.id === activeId) return 1;
    if (sort === 'name') return compareNames(left, right);
    if (sort === 'created') {
      return compareNewest(left, right, (workspace) => workspace.createdAt);
    }
    return compareNewest(
      left,
      right,
      (workspace) => workspace.lastOpenedAt ?? workspace.updatedAt,
    );
  });
}
