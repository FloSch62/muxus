import { describe, expect, it } from 'vitest';
import type { AppWindowLaunch } from '@muxus/shared';
import { workspaceOwnershipUpdate } from '../../../desktop/src/workspace-window-state.js';

describe('Electrobun workspace window reload state', () => {
  it('updates a workspace window to reload its current workspace and name', () => {
    const launch: AppWindowLaunch = {
      kind: 'workspace',
      workspaceId: 'original',
      title: 'Original workspace',
    };

    expect(workspaceOwnershipUpdate(launch, 'operations', 'Operations', false)).toEqual({
      accepted: true,
      activeWorkspaceId: 'operations',
      reloadLaunch: {
        kind: 'workspace',
        workspaceId: 'operations',
        title: 'Operations',
      },
    });
  });

  it('preserves a session launch while tracking live workspace ownership', () => {
    const launch: AppWindowLaunch = {
      kind: 'session',
      profile: { kind: 'local', shell: '/bin/zsh' },
      title: 'Local shell',
    };

    expect(workspaceOwnershipUpdate(launch, undefined, 'Unsaved workspace', false)).toEqual({
      accepted: true,
      reloadLaunch: launch,
    });
    expect(workspaceOwnershipUpdate(launch, 'auto-saved', 'Workspace 1', false)).toEqual({
      accepted: true,
      activeWorkspaceId: 'auto-saved',
      reloadLaunch: launch,
    });
  });

  it('only clears a workspace launch after an explicit detach', () => {
    const launch: AppWindowLaunch = {
      kind: 'workspace',
      workspaceId: 'deleted',
      title: 'Deleted workspace',
    };

    expect(workspaceOwnershipUpdate(launch, undefined, 'Unsaved workspace', false)).toEqual({
      accepted: true,
      reloadLaunch: launch,
    });
    expect(workspaceOwnershipUpdate(launch, undefined, 'Unsaved workspace', true)).toEqual({
      accepted: true,
      reloadLaunch: undefined,
    });
    expect(workspaceOwnershipUpdate(launch, '', 'Invalid', false)).toEqual({
      accepted: false,
      reloadLaunch: launch,
    });
  });
});
