import {
  folderDepth,
  folderParentPath,
  folderPath,
  folderSegments,
  isDescendantPath,
  isSamePath,
  MAX_FOLDER_DEPTH,
  MAX_GROUP_PATH,
  normalizeGroupPath,
  renameFolderPath,
} from '../../host-tree.js';
import type { ManagedHost } from '../../managed-hosts.js';

/** One host's group after a folder operation; null clears it to the root. */
export interface FolderMove {
  host: ManagedHost;
  group: string | null;
}

/**
 * Which hosts a rename or re-parent touches, and where each lands.
 *
 * Always call this with the *unfiltered* host lists. Computing it from the
 * filtered sidebar would silently leave every non-matching host behind on the
 * old path, splitting one folder into two.
 */
export function folderRewritePlan(
  hosts: readonly ManagedHost[],
  from: string,
  to: string,
): FolderMove[] {
  const target = normalizeGroupPath(to);
  // Compared exactly rather than by folder identity: folders match
  // case-insensitively, but capitalisation is still part of the name, so
  // "prod" → "Prod" is a rename the sidebar has to carry out.
  if (!target || target === normalizeGroupPath(from)) return [];
  return hosts.flatMap((host) => {
    const current = host.entry.metadata?.group;
    if (!current) return [];
    const next = renameFolderPath(current, from, target);
    return next === undefined || next === current ? [] : [{ host, group: next }];
  });
}

/**
 * Deleting a folder lifts its contents one level up rather than dropping them:
 * removing `Production/EU` leaves its hosts in `Production` and promotes
 * `Production/EU/Edge` to `Production/Edge`.
 */
export function deleteFolderPlan(hosts: readonly ManagedHost[], path: string): FolderMove[] {
  const parentSegments = folderSegments(folderParentPath(path));
  const depth = folderDepth(path);
  return hosts.flatMap((host) => {
    const current = host.entry.metadata?.group;
    if (!current) return [];
    if (!isSamePath(current, path) && !isDescendantPath(current, path)) return [];
    const tail = folderSegments(current).slice(depth);
    return [{ host, group: folderPath([...parentSegments, ...tail]) || null }];
  });
}

/** Assign one host to a folder; an empty path moves it to the root. */
export function moveHostPlan(host: ManagedHost, path: string): FolderMove {
  return { host, group: normalizeGroupPath(path) || null };
}

export type FolderProblem =
  | { kind: 'empty' }
  | { kind: 'too-deep' }
  | { kind: 'too-long' }
  | { kind: 'into-descendant' };

/** Why a folder cannot be renamed or moved to `to`, if it cannot. */
export function folderTargetProblem(from: string, to: string): FolderProblem | undefined {
  const target = normalizeGroupPath(to);
  if (!target) return { kind: 'empty' };
  if (target.length > MAX_GROUP_PATH) return { kind: 'too-long' };
  if (folderDepth(target) > MAX_FOLDER_DEPTH) return { kind: 'too-deep' };
  if (from && isDescendantPath(target, from)) return { kind: 'into-descendant' };
  return undefined;
}

export function folderProblemMessage(problem: FolderProblem, name = 'folder'): string {
  switch (problem.kind) {
    case 'empty':
      return 'Enter a folder name.';
    case 'too-long':
      return `That path is longer than ${MAX_GROUP_PATH} characters.`;
    case 'too-deep':
      return `Folders can nest ${MAX_FOLDER_DEPTH} levels deep.`;
    case 'into-descendant':
      return `A ${name} cannot be moved inside itself.`;
  }
}
