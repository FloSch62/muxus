import type { AppWindowLaunch } from '@muxus/shared';

export interface WorkspaceOwnershipUpdate {
  accepted: boolean;
  activeWorkspaceId?: string;
  reloadLaunch?: AppWindowLaunch;
}

function validWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function validWorkspaceTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/**
 * Keep the secondary window's reload descriptor separate from its live
 * workspace ownership. Session windows retain their original launch profile;
 * workspace windows follow the workspace the user most recently selected.
 */
export function workspaceOwnershipUpdate(
  reloadLaunch: AppWindowLaunch | undefined,
  workspaceId: unknown,
  workspaceTitle: unknown,
  clearReloadLaunch: unknown,
): WorkspaceOwnershipUpdate {
  if (workspaceId === undefined || workspaceId === null) {
    return {
      accepted: true,
      reloadLaunch:
        clearReloadLaunch === true && reloadLaunch?.kind === 'workspace'
          ? undefined
          : reloadLaunch,
    };
  }
  if (!validWorkspaceId(workspaceId)) return { accepted: false, reloadLaunch };

  if (reloadLaunch?.kind !== 'workspace') {
    return { accepted: true, activeWorkspaceId: workspaceId, reloadLaunch };
  }
  return {
    accepted: true,
    activeWorkspaceId: workspaceId,
    reloadLaunch: {
      kind: 'workspace',
      workspaceId,
      title: validWorkspaceTitle(workspaceTitle) ? workspaceTitle : reloadLaunch.title,
    },
  };
}
