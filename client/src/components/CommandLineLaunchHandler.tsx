import { useCallback, useEffect, useRef, useState } from 'react';
import { parseConnectionLink, type CommandLineLaunch } from '@muxus/shared';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import {
  resolveCommandLineFolder,
  resolveCommandLineHost,
  resolveCommandLineWorkspace,
  resolveConnectionLink,
  type TargetResolution,
} from '../command-line-launch.js';
import { managedHostDisplayName } from '../managed-hosts.js';
import {
  connectManagedHost,
  connectTarget,
  launchManagedHostGroup,
  openSessionProfile,
} from '../session-actions.js';
import { showToast } from '../state/toast.js';
import { useWorkspacesStore } from '../state/workspaces.js';
import { focusOpenWorkspace } from '../workspace-persistence.js';
import { openAppWindow } from '../window-management.js';

interface QueuedLaunch {
  id: number;
  request: CommandLineLaunch;
}

/** A link as it may appear in a notification: short, and only printable characters. */
function linkLabel(url: string): string {
  const printable = url.trim().replace(/\p{C}/gu, '�');
  return printable.length > 80 ? `${printable.slice(0, 79)}…` : printable;
}

function resolutionError(
  kind: CommandLineLaunch['kind'],
  name: string,
  resolution: Exclude<TargetResolution<unknown>, { status: 'found' }>,
): string {
  const label = kind === 'folder' ? 'folder' : kind;
  return resolution.status === 'not-found'
    ? `No ${label} named “${name}” was found.`
    : `More than one ${label} matches “${name}”. Use its exact ${
        kind === 'folder' ? 'path' : 'name or ID'
      }.`;
}

/** Execute desktop CLI requests once the normal application catalogs are ready. */
export function CommandLineLaunchHandler() {
  const initialRequest = window.muxusDesktop?.commandLineLaunch;
  const nextId = useRef(1);
  const processing = useRef(new Set<number>());
  const [queue, setQueue] = useState<QueuedLaunch[]>(() =>
    initialRequest ? [{ id: 0, request: initialRequest }] : [],
  );
  const active = queue[0];
  const needsHostCatalog =
    active?.request.kind === 'host' ||
    active?.request.kind === 'folder' ||
    active?.request.kind === 'url';
  const sshQuery = useSshConfig(needsHostCatalog);
  const profilesQuery = useSavedHostProfiles(needsHostCatalog);
  const hostCatalogReady = !!sshQuery.data && !!profilesQuery.data;
  const hostCatalogError =
    (!sshQuery.data && sshQuery.isError) ||
    (!profilesQuery.data && profilesQuery.isError);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspacesStore((state) => state.activeId);
  const workspacesReady = useWorkspacesStore((state) => state.ready);

  const enqueue = useCallback((request: CommandLineLaunch) => {
    const id = nextId.current++;
    setQueue((current) => [...current, { id, request }]);
  }, []);

  useEffect(() => window.muxusDesktop?.onCommandLineLaunch(enqueue), [enqueue]);

  useEffect(() => {
    if (!active || !workspacesReady || processing.current.has(active.id)) return;
    if (needsHostCatalog && !hostCatalogReady && !hostCatalogError) return;

    processing.current.add(active.id);
    const { request } = active;
    const finish = () => {
      setQueue((current) => current.filter((entry) => entry.id !== active.id));
    };

    void (async () => {
      if (needsHostCatalog && hostCatalogError) {
        showToast('error', 'Could not load the host catalog for the command-line request.');
        return;
      }

      if (request.kind === 'connect') {
        // Dialed like `ssh <target>`, so ssh_config still supplies keys and jumps.
        connectTarget(request.name);
        showToast('info', `Connecting to “${request.name}”.`);
        return;
      }

      const ssh = sshQuery.data;
      const profiles = profilesQuery.data;
      if (request.kind === 'url') {
        const parsed = parseConnectionLink(request.name);
        if (!parsed.ok) {
          showToast('error', `Cannot open “${linkLabel(request.name)}”. ${parsed.error}`);
          return;
        }
        const launch = resolveConnectionLink(
          parsed.link,
          ssh?.hosts ?? [],
          profiles?.profiles ?? [],
        );
        if (launch.kind === 'ad-hoc') {
          openSessionProfile(launch.profile, launch.title);
          showToast('info', `Connecting to “${launch.title}”.`);
          return;
        }
        const name = managedHostDisplayName(launch.host);
        openSessionProfile(launch.profile, name, launch.host.entry.metadata?.color);
        showToast('info', `Connecting to “${name}”.`);
        return;
      }

      if (request.kind === 'host') {
        const resolution = resolveCommandLineHost(
          request.name,
          ssh?.hosts ?? [],
          profiles?.profiles ?? [],
        );
        if (resolution.status !== 'found') {
          showToast('error', resolutionError(request.kind, request.name, resolution));
          return;
        }
        connectManagedHost(resolution.value);
        showToast('info', `Connecting to “${managedHostDisplayName(resolution.value)}”.`);
        return;
      }

      if (request.kind === 'folder') {
        const resolution = resolveCommandLineFolder(
          request.name,
          ssh?.hosts ?? [],
          profiles?.profiles ?? [],
          ssh?.files ?? [],
          ssh?.path,
        );
        if (resolution.status !== 'found') {
          showToast('error', resolutionError(request.kind, request.name, resolution));
          return;
        }
        const ids = await launchManagedHostGroup(resolution.value.hosts, 'tabs');
        if (ids.length > 0) {
          showToast(
            'success',
            `Launching ${ids.length} session${ids.length === 1 ? '' : 's'} from “${resolution.value.label}”.`,
          );
        }
        return;
      }

      const resolution = resolveCommandLineWorkspace(request.name, workspaces);
      if (resolution.status !== 'found') {
        showToast('error', resolutionError(request.kind, request.name, resolution));
        return;
      }
      if (resolution.value.id === activeWorkspaceId) {
        showToast('info', `Workspace “${resolution.value.name}” is already open.`);
      } else if (focusOpenWorkspace(resolution.value.id)) {
        showToast('info', `Switched to the window showing “${resolution.value.name}”.`);
      } else {
        openAppWindow({
          kind: 'workspace',
          workspaceId: resolution.value.id,
          title: resolution.value.name,
        });
        showToast('info', `Opening workspace “${resolution.value.name}” in a new window.`);
      }
    })()
      .catch((error: unknown) => {
        showToast(
          'error',
          error instanceof Error ? error.message : 'The command-line launch failed.',
        );
      })
      .finally(finish);
  }, [
    active,
    activeWorkspaceId,
    hostCatalogError,
    hostCatalogReady,
    needsHostCatalog,
    profilesQuery.data,
    sshQuery.data,
    workspaces,
    workspacesReady,
  ]);

  return null;
}
