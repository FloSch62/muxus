import {
  environmentArgv,
  environmentCommandLine,
  savedHostHop,
  type EnvironmentTarget,
  type SavedHostProfile,
  type SshHostEntry,
} from '@muxus/shared';
import {
  blankDraft,
  draftFromEntry,
  draftFromSavedSshProfile,
  type HostDraft,
} from './components/host-editor/draft.js';
import { newLocalShellProfileId } from './local-shell-profile.js';
import type { EnvironmentHost } from './state/environments.js';
import { usePrefsStore, type LocalShellProfileConfig } from './state/prefs.js';
import { showToast } from './state/toast.js';
import { useUiStore } from './state/ui.js';

/** The hosts the sidebar knows, to copy a parent host's connection settings from. */
export interface HostDirectory {
  sshHosts: readonly SshHostEntry[];
  savedProfiles: readonly SavedHostProfile[];
}

type Parent =
  | { kind: 'openssh'; entry: SshHostEntry }
  | { kind: 'saved'; entry: SavedHostProfile }
  | { kind: 'target'; target: string };

function parentOf(host: EnvironmentHost, hosts: HostDirectory): Parent | undefined {
  const profile = host.profile;
  if (!profile) return undefined;
  if (profile.profileId) {
    const entry = hosts.savedProfiles.find((saved) => saved.id === profile.profileId);
    return entry?.profile.kind === 'ssh' ? { kind: 'saved', entry } : undefined;
  }
  const entry = hosts.sshHosts.find((candidate) => candidate.aliases.includes(profile.target));
  return entry ? { kind: 'openssh', entry } : { kind: 'target', target: profile.target };
}

/** Host names become OpenSSH aliases: no spaces or pattern characters. */
function aliasFor(name: string): string {
  return name.replace(/[\s#*?!,]+/g, '-');
}

/**
 * A new SSH host that runs `target` on `host`: a copy of the host's own
 * connection settings whose remote command enters the container. File
 * browsing and discovery would see the host, not the container, so both are off.
 */
export function enterHostDraft(
  host: EnvironmentHost,
  hosts: HostDirectory,
  name: string,
  target: EnvironmentTarget,
): HostDraft | undefined {
  const parent = parentOf(host, hosts);
  if (!parent) return undefined;
  const base =
    parent.kind === 'saved'
      ? draftFromSavedSshProfile(parent.entry, true)
      : parent.kind === 'openssh'
        ? {
            ...draftFromEntry(parent.entry, true),
            // A block named after its host has no HostName; the copy needs one.
            hostname: parent.entry.options.hostname ?? parent.entry.resolved.hostname,
          }
        : blankDraft(parent.target, '', usePrefsStore.getState().newSshHostStorage);
  return {
    ...base,
    aliasText: base.storage === 'openssh' ? aliasFor(name) : name,
    displayName: '',
    description: '',
    forwards: [],
    remoteCommandMode: 'command',
    remoteCommand: environmentCommandLine(target),
    requestTty: 'force',
    disableSftp: true,
    discoverEnvironments: 'off',
  };
}

/**
 * A new SSH host for an address only `host` can reach (a lab node, a VM),
 * jumping through it. A hop to a Muxus saved host only exists in Muxus
 * storage, so such a host is stored there.
 */
export function jumpHostDraft(
  host: EnvironmentHost,
  hosts: HostDirectory,
  options: { name: string; address: string; user?: string; group?: string },
): HostDraft {
  const parent = parentOf(host, hosts);
  const storage = parent?.kind === 'saved' ? 'muxus' : usePrefsStore.getState().newSshHostStorage;
  const hop =
    parent?.kind === 'saved'
      ? savedHostHop(parent.entry.id)
      : parent?.kind === 'openssh'
        ? parent.entry.alias
        : parent?.target;
  const base = blankDraft('', options.group ?? '', storage);
  return {
    ...base,
    aliasText: storage === 'openssh' ? aliasFor(options.name) : options.name,
    hostname: options.address,
    user: options.user ?? '',
    ...(hop ? { routeMode: 'jump' as const, proxyJump: [hop] } : {}),
  };
}

/** A local terminal profile that runs `target` on this computer. */
export function localEnterProfile(name: string, target: EnvironmentTarget): Omit<LocalShellProfileConfig, 'id'> {
  const [shell = '', ...args] = environmentArgv(target);
  return { name, shell, args, cwd: '', startupCommand: '' };
}

/**
 * Keep something found on a host as a sidebar entry. On this computer it
 * becomes a local terminal profile; on an SSH host the host editor opens with
 * a new host filled in, to name and file before saving.
 */
export function addEnvironmentToHosts(
  host: EnvironmentHost,
  hosts: HostDirectory,
  name: string,
  target: EnvironmentTarget,
): void {
  if (!host.profile) {
    const { localShellProfiles, set } = usePrefsStore.getState();
    set({
      localShellProfiles: [
        ...localShellProfiles,
        { ...localEnterProfile(name, target), id: newLocalShellProfileId(localShellProfiles.length) },
      ],
    });
    showToast('success', `${name} was added to the local terminals.`);
    return;
  }
  const draft = enterHostDraft(host, hosts, name, target);
  if (!draft) {
    showToast('warning', `${host.label} is not a saved host, so ${name} cannot be added.`);
    return;
  }
  useUiStore.getState().setHostEditor({ mode: 'new', draft });
}

export function addAddressToHosts(
  host: EnvironmentHost,
  hosts: HostDirectory,
  options: { name: string; address: string; user?: string; group?: string },
): void {
  useUiStore.getState().setHostEditor({ mode: 'new', draft: jumpHostDraft(host, hosts, options) });
}
