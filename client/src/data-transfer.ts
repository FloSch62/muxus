import type {
  ExternalPasswordRef,
  FolderAuthSettings,
  FolderSettingsResponse,
  HostBlockOptions,
  HostUpsertRequest,
  LoginSequence,
  ManagedHostRef,
  OpenSshMetadataPatch,
  PasswordManagerSource,
  PasswordManagersResponse,
  SavedHostProfile,
  SavedHostProfilesResponse,
  SavedManagementRequest,
  SavedScript,
  SavedScriptsResponse,
  SessionHistorySettings,
  SessionHistoryStorageStatus,
  SessionLogFileSettings,
  SessionLogFileStatus,
  SessionLoggingPolicy,
  SessionLoggingPolicyInput,
  SharedSessionSource,
  SharedSessionSourceInput,
  SharedSessionSourcesResponse,
  SshConfigResponse,
  SshHostEntry,
  TunnelRecord,
  TunnelsResponse,
  WorkspaceRecord,
  WorkspaceSummary,
} from '@muxus/shared';
import {
  MAX_PASTE_CHAR_DELAY_MS,
  MAX_PASTE_LINE_DELAY_MS,
  MAX_SHARED_SESSIONS_REFRESH_MINUTES,
  PASSWORD_MANAGER_KINDS,
  TERMINAL_BACKSPACE_KEYS,
  TERMINAL_ENTER_KEYS,
  validPasteDelay,
} from '@muxus/shared';
import {
  MAX_JUMP_FALLBACKS,
  MAX_JUMP_HOPS,
  MAX_SSH_KEEPALIVE_INTERVAL_SECONDS,
} from '@muxus/shared/ws-protocol';
import { apiFetch } from './api/http.js';
import { fetchHostPreview } from './api/ssh-config.js';
import { savedProfileFolderDefaults } from './folder-defaults.js';
import { isAntiIdle } from './anti-idle.js';
import {
  DEFAULT_COMMAND_GROUP,
  normalizeCommandButtonGroups,
  normalizeCommandButtons,
} from './command-buttons.js';
import { MIN_ENVIRONMENTS_PANEL_WIDTH } from './environments-panel-width.js';
import { isKeywordHighlightProfileArray } from './highlight-profiles.js';
import { isMonitorColumnList, isMonitorInterval, isMonitorSort } from './host-monitor.js';
import { isStatusBarItemList } from './host-stats.js';
import { isHostsTableSort } from './hosts-table-sort.js';
import { isLoginSequence } from './login-sequence.js';
import { isCustomTerminalSchemeArray } from './terminal/custom-schemes.js';
import {
  hostTerminalInputModes,
  terminalInputModesPatch,
  type TerminalInputModes,
} from './terminal/input-modes.js';
import { isPastePromptWait } from './terminal/paste-prompt.js';
import { saveTextFile } from './save-file.js';
import { openSshJumpHops } from './saved-hosts.js';
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from './sidebar-width.js';
import {
  ENVIRONMENT_REFRESH_SECONDS,
  MAX_INACTIVE_PANE_DIM_STRENGTH,
  MIN_INACTIVE_PANE_DIM_STRENGTH,
  isCommandBarPosition,
  isLocalShellProfileArray,
  isNewSshHostStorage,
  isHostsTabView,
  isSidebarHostGrouping,
  isSidebarHostView,
  isSidebarOpenGesture,
  isSidebarPosition,
  isTabNumberVisibility,
  isTerminalFileLinkActivation,
  usePrefsStore,
  type FolderStyle,
  type PrefsState,
} from './state/prefs.js';
import { isFolderIconId } from './components/sidebar/folder-icons.js';
import { announceWorkspaceCatalogChange, openWorkspaceIds } from './workspace-sync.js';

export const BACKUP_FORMAT = 'muxus-backup';
export const TRANSFER_VERSION = 2;
const LEGACY_TRANSFER_VERSION = 1;
export const MAX_TRANSFER_FILE_BYTES = 20 * 1024 * 1024;

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * Where every setting belongs. `backup` puts it in a backup file, `local`
 * keeps it on this computer. A setting that is missing here does not compile,
 * so a new one cannot be left out of backups by forgetting it. A backed-up
 * setting also needs its check in `sanitizePreferences` to come back on a
 * restore, which a unit test holds this list against.
 */
const PREFERENCE_PLACEMENT = {
  themeMode: 'backup',
  monoFontSize: 'backup',
  fontFamily: 'backup',
  lineHeight: 'backup',
  lightTerminalScheme: 'backup',
  darkTerminalScheme: 'backup',
  customTerminalSchemes: 'backup',
  fontColor: 'backup',
  backgroundColor: 'backup',
  activePaneBorder: 'backup',
  dimInactivePanes: 'backup',
  inactivePaneDimStrength: 'backup',
  scrollback: 'backup',
  cursorBlink: 'backup',
  cursorStyle: 'backup',
  webglRenderer: 'backup',
  localShell: 'backup',
  localShellProfiles: 'backup',
  defaultLocalShellProfileId: 'backup',
  showWslDistributions: 'backup',
  copyOnSelect: 'backup',
  allowOsc52ClipboardWrite: 'backup',
  rightClickAction: 'backup',
  terminalFileLinkActivation: 'backup',
  pasteWarnMultiline: 'backup',
  pasteWarnLookalikes: 'backup',
  pasteLineDelayMs: 'backup',
  pasteCharDelayMs: 'backup',
  confirmCloseConnected: 'backup',
  closeTabOnCleanExit: 'backup',
  showProgramStatus: 'backup',
  discoverEnvironments: 'backup',
  environmentRefreshSeconds: 'backup',
  autoReconnectRemote: 'backup',
  sshKeepaliveIntervalSeconds: 'backup',
  sshSessionSummary: 'backup',
  rememberPasswordsByDefault: 'backup',
  newSshHostStorage: 'backup',
  x11Enabled: 'backup',
  x11ForwardByDefault: 'backup',
  x11ClipboardSharing: 'backup',
  notifyOnNewVersion: 'backup',
  restoreScrollback: 'backup',
  splitInheritsSession: 'backup',
  tabNumberVisibility: 'backup',
  keybindings: 'backup',
  commandButtons: 'backup',
  commandButtonGroups: 'backup',
  selectedCommandButtonGroup: 'backup',
  showCommandBar: 'backup',
  commandBarPosition: 'backup',
  showStatusBar: 'backup',
  statusBarItems: 'backup',
  monitorColumns: 'backup',
  monitorSort: 'backup',
  monitorIntervalMs: 'backup',
  monitorKeptHosts: 'backup',
  keywordHighlights: 'backup',
  keywordHighlightProfiles: 'backup',
  sidebarCollapsed: 'backup',
  sidebarPosition: 'backup',
  sidebarOpenGesture: 'backup',
  sidebarRailPinned: 'backup',
  sidebarHostView: 'backup',
  sidebarHostGrouping: 'backup',
  hostsTabView: 'backup',
  hostsTabSort: 'backup',
  sidebarWidth: 'backup',
  sidebarCollapsedFolders: 'backup',
  sidebarFolderStyles: 'backup',
  sidebarFolderOrder: 'backup',
  sidebarEmptyFolders: 'backup',
  showHiddenFiles: 'backup',
  environmentsPanelWidth: 'backup',
  // Follows the screen in front of this computer.
  interfaceZoom: 'local',
  // A diagnostic switch for one computer, not a way of working.
  debugMode: 'local',
} as const satisfies Record<keyof Omit<PrefsState, 'set'>, 'backup' | 'local'>;

type PreferenceKey = keyof typeof PREFERENCE_PLACEMENT;
type BackedUpPreferenceKey = {
  [Key in PreferenceKey]: (typeof PREFERENCE_PLACEMENT)[Key] extends 'backup' ? Key : never;
}[PreferenceKey];

/** The settings a backup carries, in the order the file lists them. */
export const PREFERENCE_KEYS = (Object.keys(PREFERENCE_PLACEMENT) as PreferenceKey[]).filter(
  (key): key is BackedUpPreferenceKey => PREFERENCE_PLACEMENT[key] === 'backup',
);

export type BackupPreferences = Pick<PrefsState, BackedUpPreferenceKey>;

export interface PortableHostMetadata extends OpenSshMetadataPatch {
  sortOrder?: number;
}

export interface PortableSshHost {
  alias: string;
  aliases: string[];
  description?: string;
  options: HostBlockOptions;
  metadata?: PortableHostMetadata;
}

export interface PortableSavedHost {
  id: string;
  name: string;
  profile: SavedHostProfile['profile'];
  metadata: PortableHostMetadata;
}

export interface PortableConnections {
  sshHosts: PortableSshHost[];
  savedHosts: PortableSavedHost[];
  hostOrder: ManagedHostRef[];
}

export interface BackupLoggingPolicy {
  profileKey: string;
  policy: SessionLoggingPolicyInput;
}

/** A folder's shared SSH defaults. The vault password never leaves the vault. */
export interface PortableFolderSettings {
  path: string;
  auth: FolderAuthSettings;
  /** Steps only: a vault step names its secret, whose value stays in the vault. */
  loginSequence?: LoginSequence;
}

/**
 * A shared sessions link. Its hosts are in the backup like any other, and
 * restoring the link with them lets it go on keeping those hosts up to date.
 */
export type PortableSharedSessionSource = Required<SharedSessionSourceInput>;

export type PortableHistorySettings = Omit<
  SessionHistorySettings,
  'storageLocation'
>;

/** The log folder is a path on this machine, so like the history location it stays behind. */
export type PortableLogFileSettings = Omit<SessionLogFileSettings, 'directory'>;

/**
 * A saved layout of tabs and panes. The scrollback of its terminals and when
 * it was last opened stay behind.
 */
export type PortableWorkspace = Pick<
  WorkspaceRecord,
  'id' | 'name' | 'layout' | 'multiExecGroups' | 'isLocked' | 'isStartup'
>;

export type PortableScript = Pick<SavedScript, 'id' | 'name' | 'body'>;

export type PortableManagementRequest = Pick<
  SavedManagementRequest,
  'id' | 'protocol' | 'profileId' | 'name' | 'request'
>;

/**
 * A connected password manager: where its database or program is, never a
 * password. Hosts and folders refer to it by its ID, so it keeps that ID.
 */
export type PortablePasswordManager = Pick<PasswordManagerSource, 'id' | 'kind' | 'name' | 'config'>;

export interface MuxusBackupData extends PortableConnections {
  preferences: BackupPreferences;
  tunnels: TunnelRecord[];
  loggingPolicies: BackupLoggingPolicy[];
  historySettings: PortableHistorySettings;
  /** Absent in backups from before log files existed. */
  logFileSettings?: PortableLogFileSettings;
  /** Absent in backups from before folder credentials existed. */
  folderSettings?: PortableFolderSettings[];
  /** Absent in backups from before shared sessions existed. */
  sharedSessionSources?: PortableSharedSessionSource[];
  /** This and the three below are absent in backups from before they were kept. */
  passwordManagers?: PortablePasswordManager[];
  workspaces?: PortableWorkspace[];
  scripts?: PortableScript[];
  managementRequests?: PortableManagementRequest[];
}

export interface MuxusBackupV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof LEGACY_TRANSFER_VERSION;
  createdAt: string;
  appVersion?: string;
  data: MuxusBackupData;
}

export interface MuxusBackupV2 {
  format: typeof BACKUP_FORMAT;
  version: typeof TRANSFER_VERSION;
  createdAt: string;
  appVersion?: string;
  data: MuxusBackupData;
}

export type TransferDocument = MuxusBackupV1 | MuxusBackupV2;
export type TransferConflictStrategy = 'keep' | 'replace';

export interface RestoreSelection {
  preferences: boolean;
  connections: boolean;
  tunnels: boolean;
  logging: boolean;
  workspaces: boolean;
  /** Saved scripts and saved NETCONF and gNMI requests. */
  library: boolean;
}

export interface RestoreResult {
  added: number;
  updated: number;
  skipped: number;
}

export interface DataSummary {
  connections: number;
  tunnels: number;
}

interface BaseSnapshot {
  sshConfig: SshConfigResponse;
  savedHosts: SavedHostProfile[];
  tunnels: TunnelRecord[];
}

/**
 * Read the lightweight counts shown in Settings without downloading the
 * per-profile logging policies.
 */
export async function fetchDataSummary(): Promise<DataSummary> {
  const [sshConfig, saved, tunnels] = await Promise.all([
    apiFetch<SshConfigResponse>('/api/ssh/config'),
    apiFetch<SavedHostProfilesResponse>('/api/profiles'),
    apiFetch<TunnelsResponse>('/api/tunnels'),
  ]);
  return {
    connections: sshConfig.hosts.length + saved.profiles.length,
    tunnels: tunnels.tunnels.length,
  };
}

export async function createBackupDocument(
  appVersion?: string,
): Promise<MuxusBackupV2> {
  const snapshot = await fetchBaseSnapshot();
  const profileKeys = [
    '*',
    'local',
    ...snapshot.sshConfig.hosts.map((host) => `ssh:${host.alias}`),
    ...snapshot.savedHosts.map((profile) => `profile:${profile.id}`),
  ];
  const [
    policies,
    storage,
    logFiles,
    folderSettings,
    sharedSessions,
    passwordManagers,
    workspaces,
    scripts,
    managementRequests,
  ] = await Promise.all([
    Promise.all(
      profileKeys.map((profileKey) =>
        apiFetch<SessionLoggingPolicy>(
          `/api/session-history/policy?profileKey=${encodeURIComponent(profileKey)}`,
        ),
      ),
    ),
    apiFetch<SessionHistoryStorageStatus>('/api/session-history/storage'),
    apiFetch<SessionLogFileStatus>('/api/session-history/log-files'),
    apiFetch<FolderSettingsResponse>('/api/folders/settings'),
    apiFetch<SharedSessionSourcesResponse>('/api/shared-sessions'),
    apiFetch<PasswordManagersResponse>('/api/password-managers'),
    fetchWorkspaces(),
    apiFetch<SavedScriptsResponse>('/api/scripts'),
    apiFetch<{ requests: SavedManagementRequest[] }>('/api/management/requests/all'),
  ]);
  const { storageLocation: _storageLocation, ...historySettings } =
    storage.settings;
  const { directory: _directory, ...logFileSettings } = logFiles.settings;
  return {
    format: BACKUP_FORMAT,
    version: TRANSFER_VERSION,
    createdAt: new Date().toISOString(),
    appVersion,
    data: {
      ...portableConnections(snapshot.sshConfig.hosts, snapshot.savedHosts),
      preferences: backupPreferences(),
      tunnels: snapshot.tunnels,
      loggingPolicies: policies
        .filter((policy) => policy.overridden)
        .map(({ profileKey, enabled, captureInput, maxPartBytes, maxParts, logToFile }) => ({
          profileKey,
          policy: { enabled, captureInput, maxPartBytes, maxParts, logToFile },
        })),
      historySettings,
      logFileSettings,
      folderSettings: folderSettings.folders
        .filter((folder) => Object.keys(folder.auth).length > 0 || folder.loginSequence)
        .map(({ path, auth, loginSequence }) => ({
          path,
          auth,
          ...(loginSequence ? { loginSequence } : {}),
        })),
      sharedSessionSources: sharedSessions.sources.map(portableSharedSessionSource),
      passwordManagers: passwordManagers.sources.map(({ id, kind, name, config }) => ({
        id,
        kind,
        name,
        config,
      })),
      workspaces: workspaces.map(
        ({ id, name, layout, multiExecGroups, isLocked, isStartup }) => ({
          id,
          name,
          layout,
          multiExecGroups,
          isLocked,
          isStartup,
        }),
      ),
      scripts: scripts.scripts.map(({ id, name, body }) => ({ id, name, body })),
      managementRequests: managementRequests.requests.map(
        ({ id, protocol, profileId, name, request }) => ({
          id,
          protocol,
          ...(profileId ? { profileId } : {}),
          name,
          request,
        }),
      ),
    },
  };
}

/** The list has no layouts, so each workspace is read in full. */
async function fetchWorkspaces(): Promise<WorkspaceRecord[]> {
  const { workspaces } = await apiFetch<{ workspaces: WorkspaceSummary[] }>('/api/workspaces');
  return Promise.all(
    workspaces.map(({ id }) =>
      apiFetch<WorkspaceRecord>(`/api/workspaces/${encodeURIComponent(id)}`),
    ),
  );
}

export async function createOpenSshExport(): Promise<string> {
  const [{ hosts }, saved, folderSettings] = await Promise.all([
    apiFetch<SshConfigResponse>('/api/ssh/config'),
    apiFetch<SavedHostProfilesResponse>('/api/profiles'),
    apiFetch<FolderSettingsResponse>('/api/folders/settings'),
  ]);
  const usedAliases = new Set(hosts.flatMap((host) => host.aliases));
  // Allocate every alias first: a saved host can jump through one exported
  // after it, and its ProxyJump must name that host's block.
  const exportedAliases = new Map<string, string>();
  for (const profile of saved.profiles) {
    if (profile.profile.kind !== 'ssh') continue;
    const base = openSshExportAlias(profile.name, profile.profile.target);
    let alias = base;
    let suffix = 2;
    while (usedAliases.has(alias)) alias = `${base}-${suffix++}`;
    usedAliases.add(alias);
    exportedAliases.set(profile.id, alias);
  }
  const nativeSshHosts = saved.profiles.flatMap((profile) => {
    const alias = exportedAliases.get(profile.id);
    if (alias === undefined) return [];
    const inherited = savedProfileFolderDefaults(
      profile.metadata.group,
      folderSettings.folders,
    );
    const options = portableSavedSshOptions(profile, inherited.auth);
    const proxyJump = openSshJumpHops(options.proxyJump ?? [], saved.profiles, (id) =>
      exportedAliases.get(id),
    );
    return [
      {
        aliases: [alias],
        description: inherited.hasPassword
          ? 'Exported from Muxus app data. Shared folder password omitted.'
          : 'Exported from Muxus app data.',
        options: { ...options, proxyJump: proxyJump.length ? proxyJump : undefined },
      },
    ];
  });
  const blocks = await Promise.all(
    [
      ...hosts.map((host) => ({
        aliases: host.aliases,
        description: host.description,
        options: portableSshOptions(host),
      })),
      ...nativeSshHosts,
    ].map((host) =>
      fetchHostPreview({
        aliases: host.aliases,
        description: host.description,
        options: host.options,
      }),
    ),
  );
  const generatedAt = new Date().toISOString();
  return [
    '# OpenSSH connection export from Muxus',
    `# Generated ${generatedAt}`,
    '# Private key files are referenced by path and are not embedded.',
    '',
    ...blocks.map((block) => block.trim()),
    '',
  ].join('\n\n');
}

function portableSavedSshOptions(
  profile: SavedHostProfile,
  inherited: FolderAuthSettings,
): HostBlockOptions {
  if (profile.profile.kind !== 'ssh') return {};
  const saved = profile.profile;
  return {
    hostname: saved.target,
    user: saved.user ?? inherited.user,
    port: saved.port ?? inherited.port,
    identityFiles: saved.identityFiles ?? inherited.identityFiles,
    certificateFiles: saved.certificateFiles,
    identitiesOnly: saved.identitiesOnly ?? inherited.identitiesOnly,
    identityAgent: saved.identityAgent ?? inherited.identityAgent,
    forwardAgent: saved.forwardAgent ?? inherited.forwardAgent,
    forwardX11: saved.forwardX11,
    proxyJump: saved.proxyJump,
    proxyCommand: saved.proxyCommand,
    forwards: saved.forwards,
    passwordOnly: saved.passwordOnly,
    remoteCommand: saved.remoteCommand,
    requestTty: saved.requestTty,
    strictHostKeyChecking: saved.strictHostKeyChecking,
  };
}

function openSshExportAlias(name: string, target: string): string {
  return (
    name
      .trim()
      .replace(/[\s#*?!]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 240) ||
    target
      .trim()
      .replace(/[\s#*?!]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 240) ||
    'muxus-host'
  );
}

export function saveTransferDocument(
  document: TransferDocument,
  filename: string,
): void {
  saveTextFile(
    filename,
    `${JSON.stringify(document, null, 2)}\n`,
    'application/json',
  );
}

export function datedTransferFilename(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `muxus-backup-${date}.muxus`;
}

/**
 * Validate the stable envelope and bounded collection shapes before any
 * restore request is made. The existing server endpoints remain the final,
 * strict validators for individual hosts and tunnels.
 */
export function parseTransferDocument(text: string): TransferDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new Error('This is not a Muxus transfer file.');
  if (
    parsed.version !== LEGACY_TRANSFER_VERSION &&
    parsed.version !== TRANSFER_VERSION
  ) {
    throw new Error(
      typeof parsed.version === 'number'
        ? `Muxus transfer version ${parsed.version} is not supported.`
        : 'This file is missing a supported transfer version.',
    );
  }
  if (parsed.format !== BACKUP_FORMAT) {
    throw new Error('This is not a Muxus backup file.');
  }
  if (
    typeof parsed.createdAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.createdAt)) ||
    !isRecord(parsed.data)
  ) {
    throw new Error('The Muxus transfer file is incomplete.');
  }
  validateConnections(parsed.data, parsed.version);
  validateBackupData(parsed.data);
  return parsed as unknown as TransferDocument;
}

export async function restoreTransferDocument(
  document: TransferDocument,
  selection: RestoreSelection,
  conflicts: TransferConflictStrategy,
): Promise<RestoreResult> {
  const result: RestoreResult = { added: 0, updated: 0, skipped: 0 };
  if (selection.connections) {
    // First, so the hosts and folders restored after them find their manager.
    await restorePasswordManagers(document.data.passwordManagers ?? [], conflicts, result);
    await restoreConnections(document.data, conflicts, result);
    await restoreFolderSettings(document.data.folderSettings ?? [], conflicts, result);
    await restoreSharedSessionSources(document.data.sharedSessionSources ?? [], conflicts, result);
  }

  if (selection.tunnels) {
    const current = await apiFetch<TunnelsResponse>('/api/tunnels');
    const currentIds = new Set(current.tunnels.map((tunnel) => tunnel.id));
    const writes = document.data.tunnels.flatMap((tunnel) => {
      const exists = currentIds.has(tunnel.id);
      if (exists && conflicts === 'keep') {
        result.skipped++;
        return [];
      }
      if (exists) result.updated++;
      else result.added++;
      return [
        apiFetch<TunnelRecord>('/api/tunnels', {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify(portableTunnelInput(tunnel)),
        }),
      ];
    });
    await Promise.all(writes);
  }

  if (selection.logging) {
    const [storage, logFiles] = await Promise.all([
      apiFetch<SessionHistoryStorageStatus>('/api/session-history/storage'),
      apiFetch<SessionLogFileStatus>('/api/session-history/log-files'),
    ]);
    const { logFileSettings } = document.data;
    await Promise.all([
      ...document.data.loggingPolicies.map(({ profileKey, policy }) =>
        apiFetch<SessionLoggingPolicy>(
          `/api/session-history/policy?profileKey=${encodeURIComponent(profileKey)}`,
          {
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify(policy),
          },
        ),
      ),
      apiFetch<SessionHistoryStorageStatus>('/api/session-history/storage', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ...document.data.historySettings,
          storageLocation: storage.settings.storageLocation,
        }),
      }),
      ...(logFileSettings
        ? [
            apiFetch<SessionLogFileStatus>('/api/session-history/log-files', {
              method: 'PUT',
              headers: JSON_HEADERS,
              body: JSON.stringify({
                ...logFileSettings,
                directory: logFiles.settings.directory,
              }),
            }),
          ]
        : []),
    ]);
    result.updated += document.data.loggingPolicies.length + (logFileSettings ? 2 : 1);
  }

  if (selection.library) {
    await restoreScripts(document.data.scripts ?? [], conflicts, result);
    await restoreManagementRequests(document.data.managementRequests ?? [], conflicts, result);
  }

  if (selection.workspaces) {
    await restoreWorkspaces(document.data.workspaces ?? [], conflicts, result);
  }

  if (selection.preferences) {
    const patch = sanitizePreferences(document.data.preferences);
    usePrefsStore.getState().set(patch);
    result.updated++;
  }

  return result;
}

/** Restore a reviewed third-party connection set through the same conflict-safe path as backups. */
export async function restoreImportedConnections(
  data: PortableConnections,
  conflicts: TransferConflictStrategy,
): Promise<RestoreResult> {
  const result: RestoreResult = { added: 0, updated: 0, skipped: 0 };
  await restoreConnections(data, conflicts, result);
  return result;
}

function fetchBaseSnapshot(): Promise<BaseSnapshot> {
  return Promise.all([
    apiFetch<SshConfigResponse>('/api/ssh/config'),
    apiFetch<SavedHostProfilesResponse>('/api/profiles'),
    apiFetch<TunnelsResponse>('/api/tunnels'),
  ]).then(([sshConfig, saved, tunnels]) => ({
    sshConfig,
    savedHosts: saved.profiles,
    tunnels: tunnels.tunnels,
  }));
}

function portableConnections(
  sshHosts: readonly SshHostEntry[],
  savedHosts: readonly SavedHostProfile[],
): PortableConnections {
  const ssh = sshHosts.map(
    (host): PortableSshHost => ({
      alias: host.alias,
      aliases: host.aliases,
      description: host.description,
      // Materialize inherited Host * / Include values so the exported
      // connection behaves the same on a machine with a different config.
      options: portableSshOptions(host),
      metadata: host.metadata
        ? portableMetadata(host.metadata, host.metadata.displayName)
        : undefined,
    }),
  );
  const saved = savedHosts.map(
    (profile): PortableSavedHost => ({
      id: profile.id,
      name: profile.name,
      profile: profile.profile,
      metadata: portableMetadata(profile.metadata),
    }),
  );
  const ordered = [
    ...ssh.map((host) => ({
      ref: { kind: 'ssh' as const, alias: host.alias },
      name: host.metadata?.displayName ?? host.alias,
      order: host.metadata?.sortOrder,
    })),
    ...saved.map((host) => ({
      ref: { kind: 'profile' as const, id: host.id },
      name: host.name,
      order: host.metadata.sortOrder,
    })),
  ].sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) -
        (b.order ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name),
  );
  return {
    sshHosts: ssh,
    savedHosts: saved,
    hostOrder: ordered.map(({ ref }) => ref),
  };
}

function portableMetadata(
  metadata: SavedHostProfile['metadata'],
  displayName?: string,
): PortableHostMetadata {
  return {
    displayName,
    group: metadata.group,
    color: metadata.color,
    icon: metadata.icon,
    terminalScheme: metadata.terminalScheme,
    terminalFontColor: metadata.terminalFontColor,
    terminalBackgroundColor: metadata.terminalBackgroundColor,
    keywordHighlights: metadata.keywordHighlights,
    commandButtonGroup: metadata.commandButtonGroup,
    pasteLineDelayMs: metadata.pasteLineDelayMs,
    pasteCharDelayMs: metadata.pasteCharDelayMs,
    pastePromptWait: metadata.pastePromptWait,
    antiIdle: metadata.antiIdle,
    backspaceKey: metadata.backspaceKey,
    enterKey: metadata.enterKey,
    implicitCr: metadata.implicitCr,
    localEcho: metadata.localEcho,
    disableSftp: metadata.disableSftp,
    consoleCompatibility: metadata.consoleCompatibility,
    systemOpenSsh: metadata.systemOpenSsh,
    discoverEnvironments: metadata.discoverEnvironments,
    loginSequence: metadata.loginSequence,
    // Null says the host has no link, so a restore that replaces takes one away.
    passwordRef: metadata.passwordRef ?? null,
    proxyJumpFallbacks: metadata.proxyJumpFallbacks,
    sortOrder: metadata.sortOrder,
  };
}

function portableSshOptions(host: SshHostEntry): HostBlockOptions {
  const resolved = host.resolved;
  return {
    ...host.options,
    hostname: resolved.hostname,
    user: resolved.user,
    port: resolved.port,
    identityFiles:
      resolved.identityFiles.length > 0 ? resolved.identityFiles : undefined,
    certificateFiles:
      resolved.certificateFiles.length > 0
        ? resolved.certificateFiles
        : undefined,
    identitiesOnly: resolved.identitiesOnly,
    forwardAgent: resolved.forwardAgent,
    forwardX11: resolved.forwardX11,
    proxyJump: resolved.proxyJump.length > 0 ? resolved.proxyJump : undefined,
    proxyCommand: resolved.proxyCommand,
    forwards: resolved.forwards.length > 0 ? resolved.forwards : undefined,
    passwordOnly: resolved.passwordOnly,
  };
}

function backupPreferences(): BackupPreferences {
  const prefs = usePrefsStore.getState();
  return Object.fromEntries(
    PREFERENCE_KEYS.map((key) => [key, prefs[key]]),
  ) as BackupPreferences;
}

async function restoreConnections(
  data: PortableConnections,
  conflicts: TransferConflictStrategy,
  result: RestoreResult,
): Promise<void> {
  const [sshConfig, savedResponse] = await Promise.all([
    apiFetch<SshConfigResponse>('/api/ssh/config'),
    apiFetch<SavedHostProfilesResponse>('/api/profiles'),
  ]);
  const sshByAlias = new Map<string, SshHostEntry>();
  for (const host of sshConfig.hosts) {
    for (const alias of host.aliases) sshByAlias.set(alias, host);
  }
  const savedIds = new Set(savedResponse.profiles.map((profile) => profile.id));

  // OpenSSH config edits intentionally stay sequential: every request
  // atomically rewrites a config file, so parallel edits could race.
  for (const host of data.sshHosts) {
    const existing = sshByAlias.get(host.alias);
    if (existing && conflicts === 'keep') {
      result.skipped++;
      continue;
    }
    const request: HostUpsertRequest = {
      aliases: host.aliases,
      description: host.description,
      options: host.options,
      ...(existing
        ? { previousAlias: existing.alias, file: existing.file }
        : {}),
    };
    await apiFetch<{ file: string }>('/api/ssh/config/hosts', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    });
    if (host.metadata) {
      await apiFetch(
        `/api/ssh/config/hosts/${encodeURIComponent(host.alias)}/metadata`,
        {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify(metadataPatch(host.metadata)),
        },
      );
    }
    if (existing) result.updated++;
    else result.added++;
  }

  for (const profile of data.savedHosts) {
    const exists = savedIds.has(profile.id);
    if (exists && conflicts === 'keep') {
      result.skipped++;
      continue;
    }
    await apiFetch<SavedHostProfile>('/api/profiles', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: profile.id,
        name: profile.name,
        profile: profile.profile,
      }),
    });
    await apiFetch(
      `/api/profiles/${encodeURIComponent(profile.id)}/metadata`,
      {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(metadataPatch(profile.metadata)),
      },
    );
    if (exists) result.updated++;
    else result.added++;
  }

  if (conflicts === 'replace' && data.hostOrder.length > 0) {
    await apiFetch('/api/hosts/order', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ hosts: data.hostOrder }),
    });
  }
}

async function restoreFolderSettings(
  entries: readonly PortableFolderSettings[],
  conflicts: TransferConflictStrategy,
  result: RestoreResult,
): Promise<void> {
  if (entries.length === 0) return;
  const current = await apiFetch<FolderSettingsResponse>('/api/folders/settings');
  const existingPaths = new Set(current.folders.map((folder) => folder.path.toLowerCase()));
  for (const entry of entries) {
    const exists = existingPaths.has(entry.path.toLowerCase());
    if (exists && conflicts === 'keep') {
      result.skipped++;
      continue;
    }
    await apiFetch<{ folder: unknown }>('/api/folders/settings', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        path: entry.path,
        auth: entry.auth,
        // A sequence that does not check out is dropped, not the whole folder.
        ...(isLoginSequence(entry.loginSequence) ? { loginSequence: entry.loginSequence } : {}),
      }),
    });
    if (exists) result.updated++;
    else result.added++;
  }
}

function portableSharedSessionSource(source: PortableSharedSessionSource): PortableSharedSessionSource {
  const { id, name, url, folder, refreshMinutes } = source;
  return { id, name, url, folder, refreshMinutes };
}

/**
 * Links come back under their own ID: the hosts restored next to them carry
 * IDs derived from it, so the next check takes those hosts over instead of
 * adding a second copy of each.
 */
async function restoreSharedSessionSources(
  entries: readonly PortableSharedSessionSource[],
  conflicts: TransferConflictStrategy,
  result: RestoreResult,
): Promise<void> {
  if (entries.length === 0) return;
  const current = await apiFetch<SharedSessionSourcesResponse>('/api/shared-sessions');
  const existingIds = new Set(current.sources.map((source) => source.id));
  for (const entry of entries) {
    const exists = existingIds.has(entry.id);
    if (exists && conflicts === 'keep') {
      result.skipped++;
      continue;
    }
    try {
      await apiFetch<SharedSessionSource>('/api/shared-sessions', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(portableSharedSessionSource(entry)),
      });
    } catch {
      // A link this computer cannot use, such as a file path of another
      // system, is left out rather than failing the restore. Its hosts are
      // restored like any others.
      result.skipped++;
      continue;
    }
    if (exists) result.updated++;
    else result.added++;
  }
}

function metadataPatch(metadata: PortableHostMetadata): OpenSshMetadataPatch {
  return {
    displayName: metadata.displayName ?? null,
    group: metadata.group ?? null,
    color: metadata.color ?? null,
    icon: metadata.icon ?? null,
    terminalScheme: metadata.terminalScheme ?? null,
    terminalFontColor: metadata.terminalFontColor ?? null,
    terminalBackgroundColor: metadata.terminalBackgroundColor ?? null,
    keywordHighlights: metadata.keywordHighlights ?? null,
    commandButtonGroup: metadata.commandButtonGroup ?? null,
    pasteLineDelayMs: metadata.pasteLineDelayMs ?? null,
    pasteCharDelayMs: metadata.pasteCharDelayMs ?? null,
    // Off for a backup without one; a setting that does not check out is dropped, not the host.
    pastePromptWait: isPastePromptWait(metadata.pastePromptWait) ? metadata.pastePromptWait : null,
    antiIdle: isAntiIdle(metadata.antiIdle) ? metadata.antiIdle : null,
    ...terminalInputModesPatch(restoredInputModes(metadata)),
    disableSftp: metadata.disableSftp ?? false,
    consoleCompatibility: metadata.consoleCompatibility ?? false,
    systemOpenSsh: metadata.systemOpenSsh ?? false,
    discoverEnvironments: typeof metadata.discoverEnvironments === 'boolean' ? metadata.discoverEnvironments : null,
    loginSequence: isLoginSequence(metadata.loginSequence) ? metadata.loginSequence : null,
    proxyJumpFallbacks: isJumpRoutes(metadata.proxyJumpFallbacks) ? metadata.proxyJumpFallbacks : null,
    // A backup from before these links were kept, and a session imported from
    // another client, say nothing about one: the host keeps the link it has.
    ...(metadata.passwordRef === null || isPasswordRef(metadata.passwordRef)
      ? { passwordRef: metadata.passwordRef }
      : {}),
  };
}

function isPasswordRef(value: unknown): value is ExternalPasswordRef {
  return (
    isRecord(value) &&
    nonEmptyString(value.sourceId) &&
    value.sourceId.length <= 200 &&
    nonEmptyString(value.entryId) &&
    value.entryId.length <= 2_000 &&
    typeof value.title === 'string' &&
    value.title.length <= 500 &&
    (value.username === undefined ||
      (typeof value.username === 'string' && value.username.length <= 500))
  );
}

/** Fallback jump routes from a backup: a list of non-empty lists of host names. */
function isJumpRoutes(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_JUMP_FALLBACKS &&
    value.every(
      (route) =>
        Array.isArray(route) &&
        route.length > 0 &&
        route.length <= MAX_JUMP_HOPS &&
        route.every((hop) => typeof hop === 'string' && hop.trim().length > 0 && hop.length <= 500),
    )
  );
}

/** A backup without keys or echo, or with values this release does not know, keeps xterm.js's. */
function restoredInputModes(metadata: PortableHostMetadata): TerminalInputModes {
  return hostTerminalInputModes({
    backspaceKey: TERMINAL_BACKSPACE_KEYS.find((key) => key === metadata.backspaceKey),
    enterKey: TERMINAL_ENTER_KEYS.find((key) => key === metadata.enterKey),
    implicitCr: metadata.implicitCr === true,
    localEcho: metadata.localEcho === true,
  });
}

/**
 * A connected password manager comes back under its own ID, which is what a
 * host or folder linked to one of its entries refers to. One this build does
 * not know, or cannot take, is left out rather than failing the restore.
 */
async function restorePasswordManagers(
  entries: readonly PortablePasswordManager[],
  conflicts: TransferConflictStrategy,
  result: RestoreResult,
): Promise<void> {
  if (entries.length === 0) return;
  const current = await apiFetch<PasswordManagersResponse>('/api/password-managers');
  const existingIds = new Set(current.sources.map((source) => source.id));
  for (const { id, kind, name, config } of entries) {
    const exists = existingIds.has(id);
    if (exists && conflicts === 'keep') {
      result.skipped++;
      continue;
    }
    if (!(PASSWORD_MANAGER_KINDS as readonly string[]).includes(kind)) {
      result.skipped++;
      continue;
    }
    try {
      await apiFetch<PasswordManagerSource>(
        exists ? `/api/password-managers/${encodeURIComponent(id)}` : '/api/password-managers',
        {
          method: exists ? 'PUT' : 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(exists ? { kind, name, config } : { id, kind, name, config }),
        },
      );
    } catch {
      result.skipped++;
      continue;
    }
    if (exists) result.updated++;
    else result.added++;
  }
}

async function restoreScripts(
  entries: readonly PortableScript[],
  conflicts: TransferConflictStrategy,
  result: RestoreResult,
): Promise<void> {
  if (entries.length === 0) return;
  const current = await apiFetch<SavedScriptsResponse>('/api/scripts');
  const existingIds = new Set(current.scripts.map((script) => script.id));
  for (const { id, name, body } of entries) {
    const exists = existingIds.has(id);
    if (exists && conflicts === 'keep') {
      result.skipped++;
      continue;
    }
    await apiFetch<SavedScript>('/api/scripts', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ id, name, body }),
    });
    if (exists) result.updated++;
    else result.added++;
  }
}

async function restoreManagementRequests(
  entries: readonly PortableManagementRequest[],
  conflicts: TransferConflictStrategy,
  result: RestoreResult,
): Promise<void> {
  if (entries.length === 0) return;
  const current = await apiFetch<{ requests: SavedManagementRequest[] }>(
    '/api/management/requests/all',
  );
  const existingIds = new Set(current.requests.map((request) => request.id));
  for (const { id, protocol, profileId, name, request } of entries) {
    const exists = existingIds.has(id);
    if (exists && conflicts === 'keep') {
      result.skipped++;
      continue;
    }
    await apiFetch<SavedManagementRequest>('/api/management/requests', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ id, protocol, ...(profileId ? { profileId } : {}), name, request }),
    });
    if (exists) result.updated++;
    else result.added++;
  }
}

/**
 * A workspace that is open in a window is left as it is, whatever was chosen
 * for conflicts: that window saves its own tabs and panes over the stored
 * layout, and putting the restored layout into the window would close the
 * sessions in it. One the server does not take, such as a layout from a
 * release with other tab kinds, is left out rather than failing the restore.
 */
async function restoreWorkspaces(
  entries: readonly PortableWorkspace[],
  conflicts: TransferConflictStrategy,
  result: RestoreResult,
): Promise<void> {
  if (entries.length === 0) return;
  const [{ workspaces: current }, open] = await Promise.all([
    apiFetch<{ workspaces: WorkspaceSummary[] }>('/api/workspaces'),
    openWorkspaceIds(),
  ]);
  const existingIds = new Set(current.map((workspace) => workspace.id));
  const present = new Set(existingIds);
  let changed = false;
  for (const { id, name, layout, multiExecGroups, isLocked } of entries) {
    const exists = existingIds.has(id);
    if (exists && (conflicts === 'keep' || open.has(id))) {
      result.skipped++;
      continue;
    }
    const route = `/api/workspaces/${encodeURIComponent(id)}`;
    try {
      const saved = await apiFetch<WorkspaceRecord>('/api/workspaces', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          id,
          name,
          layout,
          multiExecGroups,
          ...(exists ? { overwriteLocked: true } : { createIfMissing: true }),
        }),
      });
      // Saving over a workspace keeps the name it has; a rename is its own request.
      if (saved.name !== name) {
        await apiFetch(route, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name }) });
      }
      if (saved.isLocked !== isLocked) {
        await apiFetch(route, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ isLocked }) });
      }
    } catch {
      result.skipped++;
      continue;
    }
    present.add(id);
    changed = true;
    if (exists) result.updated++;
    else result.added++;
  }

  // The workspace that opens at startup follows the file, unless this
  // computer has its own choice and existing items are being kept.
  const startup = entries.find((entry) => entry.isStartup && present.has(entry.id));
  const currentStartup = current.find((workspace) => workspace.isStartup);
  if (
    startup &&
    startup.id !== currentStartup?.id &&
    (conflicts === 'replace' || !currentStartup)
  ) {
    await apiFetch('/api/workspaces/startup', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: startup.id }),
    });
    changed = true;
  }
  if (changed) announceWorkspaceCatalogChange();
}

function portableTunnelInput(tunnel: TunnelRecord): Omit<TunnelRecord, 'createdAt' | 'updatedAt'> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = tunnel;
  return input;
}

/**
 * The second half of the restore barrier, next to `parseTransferDocument`:
 * structure is validated there, individual values here. Anything that fails
 * is dropped rather than rejecting the whole backup.
 */
export function sanitizePreferences(
  input: BackupPreferences & { terminalScheme?: unknown },
): Partial<PrefsState> {
  const output: Partial<PrefsState> = {};
  if (['light', 'dark', 'os'].includes(input.themeMode)) {
    output.themeMode = input.themeMode;
  }
  if (finiteRange(input.monoFontSize, 8, 24)) {
    output.monoFontSize = input.monoFontSize;
  }
  if (typeof input.fontFamily === 'string' && input.fontFamily.length <= 200) {
    output.fontFamily = input.fontFamily;
  }
  if (finiteRange(input.lineHeight, 1, 1.6)) output.lineHeight = input.lineHeight;
  const legacyTerminalScheme = validTerminalSchemePreference(input.terminalScheme)
    ? input.terminalScheme
    : undefined;
  if (validTerminalSchemePreference(input.lightTerminalScheme)) {
    output.lightTerminalScheme = input.lightTerminalScheme;
  } else if (legacyTerminalScheme !== undefined) {
    output.lightTerminalScheme = legacyTerminalScheme;
  }
  if (validTerminalSchemePreference(input.darkTerminalScheme)) {
    output.darkTerminalScheme = input.darkTerminalScheme;
  } else if (legacyTerminalScheme !== undefined) {
    output.darkTerminalScheme = legacyTerminalScheme;
  }
  if (isCustomTerminalSchemeArray(input.customTerminalSchemes)) {
    output.customTerminalSchemes = input.customTerminalSchemes;
  }
  if (input.fontColor === '' || validHexColor(input.fontColor)) {
    output.fontColor = input.fontColor;
  }
  if (input.backgroundColor === '' || validHexColor(input.backgroundColor)) {
    output.backgroundColor = input.backgroundColor;
  }
  if (typeof input.activePaneBorder === 'boolean') {
    output.activePaneBorder = input.activePaneBorder;
  }
  if (typeof input.dimInactivePanes === 'boolean') {
    output.dimInactivePanes = input.dimInactivePanes;
  }
  if (
    finiteRange(
      input.inactivePaneDimStrength,
      MIN_INACTIVE_PANE_DIM_STRENGTH,
      MAX_INACTIVE_PANE_DIM_STRENGTH,
    )
  ) {
    output.inactivePaneDimStrength = input.inactivePaneDimStrength;
  }
  if (
    Number.isInteger(input.scrollback) &&
    finiteRange(input.scrollback, 0, 1_000_000)
  ) {
    output.scrollback = input.scrollback;
  }
  if (typeof input.cursorBlink === 'boolean') output.cursorBlink = input.cursorBlink;
  if (['block', 'underline', 'bar'].includes(input.cursorStyle)) {
    output.cursorStyle = input.cursorStyle;
  }
  if (typeof input.webglRenderer === 'boolean') output.webglRenderer = input.webglRenderer;
  if (typeof input.localShell === 'string' && input.localShell.length <= 4096) {
    output.localShell = input.localShell;
  }
  if (isLocalShellProfileArray(input.localShellProfiles)) {
    output.localShellProfiles = input.localShellProfiles;
  }
  if (
    typeof input.defaultLocalShellProfileId === 'string' &&
    input.defaultLocalShellProfileId.length <= 200 &&
    (!input.defaultLocalShellProfileId ||
      output.localShellProfiles?.some(
        (profile) => profile.id === input.defaultLocalShellProfileId,
      ))
  ) {
    output.defaultLocalShellProfileId = input.defaultLocalShellProfileId;
  }
  if (typeof input.showWslDistributions === 'boolean') {
    output.showWslDistributions = input.showWslDistributions;
  }
  if (typeof input.copyOnSelect === 'boolean') output.copyOnSelect = input.copyOnSelect;
  if (typeof input.allowOsc52ClipboardWrite === 'boolean') {
    output.allowOsc52ClipboardWrite = input.allowOsc52ClipboardWrite;
  }
  if (['copy-paste', 'paste', 'menu'].includes(input.rightClickAction)) {
    output.rightClickAction = input.rightClickAction;
  }
  if (isTerminalFileLinkActivation(input.terminalFileLinkActivation)) {
    output.terminalFileLinkActivation = input.terminalFileLinkActivation;
  }
  if (typeof input.pasteWarnMultiline === 'boolean') {
    output.pasteWarnMultiline = input.pasteWarnMultiline;
  }
  if (typeof input.pasteWarnLookalikes === 'boolean') {
    output.pasteWarnLookalikes = input.pasteWarnLookalikes;
  }
  if (validPasteDelay(input.pasteLineDelayMs, MAX_PASTE_LINE_DELAY_MS)) {
    output.pasteLineDelayMs = input.pasteLineDelayMs;
  }
  if (validPasteDelay(input.pasteCharDelayMs, MAX_PASTE_CHAR_DELAY_MS)) {
    output.pasteCharDelayMs = input.pasteCharDelayMs;
  }
  if (typeof input.confirmCloseConnected === 'boolean') {
    output.confirmCloseConnected = input.confirmCloseConnected;
  }
  if (typeof input.closeTabOnCleanExit === 'boolean') {
    output.closeTabOnCleanExit = input.closeTabOnCleanExit;
  }
  if (typeof input.showProgramStatus === 'boolean') {
    output.showProgramStatus = input.showProgramStatus;
  }
  if (typeof input.discoverEnvironments === 'boolean') {
    output.discoverEnvironments = input.discoverEnvironments;
  }
  if ((ENVIRONMENT_REFRESH_SECONDS as readonly unknown[]).includes(input.environmentRefreshSeconds)) {
    output.environmentRefreshSeconds = input.environmentRefreshSeconds;
  }
  if (typeof input.autoReconnectRemote === 'boolean') {
    output.autoReconnectRemote = input.autoReconnectRemote;
  }
  if (
    Number.isInteger(input.sshKeepaliveIntervalSeconds) &&
    finiteRange(input.sshKeepaliveIntervalSeconds, 0, MAX_SSH_KEEPALIVE_INTERVAL_SECONDS)
  ) {
    output.sshKeepaliveIntervalSeconds = input.sshKeepaliveIntervalSeconds;
  }
  if (typeof input.sshSessionSummary === 'boolean') {
    output.sshSessionSummary = input.sshSessionSummary;
  }
  if (typeof input.rememberPasswordsByDefault === 'boolean') {
    output.rememberPasswordsByDefault = input.rememberPasswordsByDefault;
  }
  if (isNewSshHostStorage(input.newSshHostStorage)) {
    output.newSshHostStorage = input.newSshHostStorage;
  }
  // Null follows the platform, which is as much a choice as on or off.
  if (input.x11Enabled === null || typeof input.x11Enabled === 'boolean') {
    output.x11Enabled = input.x11Enabled;
  }
  if (input.x11ForwardByDefault === null || typeof input.x11ForwardByDefault === 'boolean') {
    output.x11ForwardByDefault = input.x11ForwardByDefault;
  }
  if (typeof input.x11ClipboardSharing === 'boolean') {
    output.x11ClipboardSharing = input.x11ClipboardSharing;
  }
  if (typeof input.notifyOnNewVersion === 'boolean') {
    output.notifyOnNewVersion = input.notifyOnNewVersion;
  }
  if (typeof input.restoreScrollback === 'boolean') {
    output.restoreScrollback = input.restoreScrollback;
  }
  if (typeof input.splitInheritsSession === 'boolean') {
    output.splitInheritsSession = input.splitInheritsSession;
  }
  if (isTabNumberVisibility(input.tabNumberVisibility)) {
    output.tabNumberVisibility = input.tabNumberVisibility;
  }
  if (validKeybindings(input.keybindings)) output.keybindings = input.keybindings;
  // Buttons are checked against the groups in the same backup; one from an
  // older release has none, so its buttons all land in the default group.
  const commandButtonGroups = normalizeCommandButtonGroups(input.commandButtonGroups);
  if (commandButtonGroups) output.commandButtonGroups = commandButtonGroups;
  const commandButtons = normalizeCommandButtons(
    input.commandButtons,
    commandButtonGroups ?? [DEFAULT_COMMAND_GROUP],
  );
  if (commandButtons) output.commandButtons = commandButtons;
  if (
    typeof input.selectedCommandButtonGroup === 'string' &&
    commandButtonGroups?.some((group) => group.id === input.selectedCommandButtonGroup)
  ) {
    output.selectedCommandButtonGroup = input.selectedCommandButtonGroup;
  }
  if (typeof input.showCommandBar === 'boolean') {
    output.showCommandBar = input.showCommandBar;
  }
  if (isCommandBarPosition(input.commandBarPosition)) {
    output.commandBarPosition = input.commandBarPosition;
  }
  if (typeof input.showStatusBar === 'boolean') {
    output.showStatusBar = input.showStatusBar;
  }
  if (isStatusBarItemList(input.statusBarItems)) {
    output.statusBarItems = input.statusBarItems;
  }
  if (isMonitorColumnList(input.monitorColumns)) output.monitorColumns = input.monitorColumns;
  if (isMonitorSort(input.monitorSort)) output.monitorSort = input.monitorSort;
  if (isMonitorInterval(input.monitorIntervalMs)) {
    output.monitorIntervalMs = input.monitorIntervalMs;
  }
  if (
    boundedArray(input.monitorKeptHosts, 10_000) &&
    input.monitorKeptHosts.every((key) => typeof key === 'string' && key.length <= 400)
  ) {
    output.monitorKeptHosts = input.monitorKeptHosts;
  }
  if (
    Array.isArray(input.keywordHighlights) &&
    input.keywordHighlights.length <= 100 &&
    input.keywordHighlights.every(validKeywordHighlight)
  ) {
    output.keywordHighlights = input.keywordHighlights;
  }
  if (isKeywordHighlightProfileArray(input.keywordHighlightProfiles)) {
    output.keywordHighlightProfiles = input.keywordHighlightProfiles;
  }
  if (typeof input.sidebarCollapsed === 'boolean') {
    output.sidebarCollapsed = input.sidebarCollapsed;
  }
  if (isSidebarPosition(input.sidebarPosition)) {
    output.sidebarPosition = input.sidebarPosition;
  }
  if (isSidebarOpenGesture(input.sidebarOpenGesture)) {
    output.sidebarOpenGesture = input.sidebarOpenGesture;
  }
  if (typeof input.sidebarRailPinned === 'boolean') {
    output.sidebarRailPinned = input.sidebarRailPinned;
  }
  if (isSidebarHostView(input.sidebarHostView)) output.sidebarHostView = input.sidebarHostView;
  if (isSidebarHostGrouping(input.sidebarHostGrouping)) {
    output.sidebarHostGrouping = input.sidebarHostGrouping;
  }
  if (isHostsTabView(input.hostsTabView)) output.hostsTabView = input.hostsTabView;
  if (isHostsTableSort(input.hostsTabSort)) {
    output.hostsTabSort = {
      ...(input.hostsTabSort.column ? { column: input.hostsTabSort.column } : {}),
      descending: input.hostsTabSort.descending,
    };
  }
  if (
    finiteRange(
      input.sidebarWidth,
      MIN_SIDEBAR_WIDTH,
      MAX_SIDEBAR_WIDTH,
    )
  ) {
    output.sidebarWidth = input.sidebarWidth;
  }
  if (typeof input.showHiddenFiles === 'boolean') {
    output.showHiddenFiles = input.showHiddenFiles;
  }
  // The panel fits itself to the window it is shown in, so only nonsense is refused.
  if (finiteRange(input.environmentsPanelWidth, MIN_ENVIRONMENTS_PANEL_WIDTH, 10_000)) {
    output.environmentsPanelWidth = input.environmentsPanelWidth;
  }
  if (boundedPathList(input.sidebarCollapsedFolders)) {
    output.sidebarCollapsedFolders = input.sidebarCollapsedFolders;
  }
  if (boundedPathList(input.sidebarEmptyFolders)) {
    output.sidebarEmptyFolders = input.sidebarEmptyFolders;
  }
  if (validFolderStyles(input.sidebarFolderStyles)) {
    output.sidebarFolderStyles = input.sidebarFolderStyles;
  }
  if (validFolderOrder(input.sidebarFolderOrder)) {
    output.sidebarFolderOrder = input.sidebarFolderOrder;
  }
  return output;
}

/** Chords per command: bounded, and strings throughout. The keymap ignores what it cannot read. */
function validKeybindings(value: unknown): value is Record<string, string[]> {
  if (!isRecord(value) || Object.keys(value).length > 1_000) return false;
  return Object.entries(value).every(
    ([command, chords]) =>
      command.length <= 200 &&
      boundedArray(chords, 20) &&
      chords.every((chord) => typeof chord === 'string' && chord.length <= 100),
  );
}

function validTerminalSchemePreference(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100;
}

function validFolderOrder(value: unknown): value is Record<string, string[]> {
  if (!isRecord(value) || Object.keys(value).length > 500) return false;
  return Object.entries(value).every(
    ([key, keys]) => key.length <= 400 && boundedPathList(keys),
  );
}

function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** Folder keys and paths: bounded in both count and length. */
function boundedPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 500 &&
    value.every((entry) => typeof entry === 'string' && entry.length <= 400)
  );
}

function validFolderStyles(value: unknown): value is Record<string, FolderStyle> {
  if (!isRecord(value) || Object.keys(value).length > 500) return false;
  return Object.entries(value).every(
    ([key, style]) =>
      key.length <= 400 &&
      isRecord(style) &&
      (style.color === undefined || validHexColor(style.color)) &&
      (style.icon === undefined ||
        (typeof style.icon === 'string' && isFolderIconId(style.icon))),
  );
}

function validateConnections(
  data: Record<string, unknown>,
  version: TransferDocument['version'],
): void {
  if (
    !boundedArray(data.sshHosts, 10_000) ||
    !boundedArray(data.savedHosts, 10_000) ||
    !boundedArray(data.hostOrder, 20_000) ||
    !data.sshHosts.every(
      (host) =>
        isRecord(host) &&
        nonEmptyString(host.alias) &&
        boundedArray(host.aliases, 100) &&
        host.aliases.length > 0 &&
        host.aliases.every(nonEmptyString) &&
        isRecord(host.options) &&
        (host.description === undefined ||
          typeof host.description === 'string') &&
        (host.metadata === undefined || isRecord(host.metadata)),
    ) ||
    !data.savedHosts.every(
      (host) =>
        isRecord(host) &&
        nonEmptyString(host.id) &&
        nonEmptyString(host.name) &&
        isRecord(host.profile) &&
        (host.profile.kind === 'telnet' ||
          host.profile.kind === 'serial' ||
          (version >= 2 &&
            (host.profile.kind === 'ssh' ||
              host.profile.kind === 'rdp' ||
              host.profile.kind === 'vnc' ||
              host.profile.kind === 'gnmi' ||
              host.profile.kind === 'netconf' ||
              host.profile.kind === 'web'))) &&
        isRecord(host.metadata),
    ) ||
    !data.hostOrder.every(
      (ref) =>
        isRecord(ref) &&
        ((ref.kind === 'ssh' && nonEmptyString(ref.alias)) ||
          (ref.kind === 'profile' && nonEmptyString(ref.id))),
    )
  ) {
    throw new Error('The connection data in this file is incomplete or too large.');
  }
  const sshAliases = data.sshHosts.map((host) =>
    String((host as Record<string, unknown>).alias),
  );
  const profileIds = data.savedHosts.map((host) =>
    String((host as Record<string, unknown>).id),
  );
  const orderKeys = data.hostOrder.map((ref) => {
    const value = ref as Record<string, unknown>;
    return value.kind === 'ssh'
      ? `ssh:${String(value.alias)}`
      : `profile:${String(value.id)}`;
  });
  const available = new Set([
    ...sshAliases.map((alias) => `ssh:${alias}`),
    ...profileIds.map((id) => `profile:${id}`),
  ]);
  if (
    new Set(sshAliases).size !== sshAliases.length ||
    new Set(profileIds).size !== profileIds.length ||
    new Set(orderKeys).size !== orderKeys.length ||
    orderKeys.some((key) => !available.has(key))
  ) {
    throw new Error('The connection data contains duplicate or unknown items.');
  }
}

function validateBackupData(data: Record<string, unknown>): void {
  if (
    !isRecord(data.preferences) ||
    !boundedArray(data.tunnels, 10_000) ||
    !boundedArray(data.loggingPolicies, 20_000) ||
    !isRecord(data.historySettings) ||
    !data.tunnels.every(
      (tunnel) =>
        isRecord(tunnel) &&
        nonEmptyString(tunnel.id) &&
        nonEmptyString(tunnel.target) &&
        ['local', 'remote', 'dynamic'].includes(String(tunnel.type)) &&
        Number.isInteger(tunnel.bindPort) &&
        (tunnel.autoStart === undefined || typeof tunnel.autoStart === 'boolean') &&
        (tunnel.autoReconnect === undefined || typeof tunnel.autoReconnect === 'boolean'),
    ) ||
    !data.loggingPolicies.every(
      (entry) =>
        isRecord(entry) &&
        nonEmptyString(entry.profileKey) &&
        isRecord(entry.policy) &&
        typeof entry.policy.enabled === 'boolean' &&
        typeof entry.policy.captureInput === 'boolean' &&
        Number.isInteger(entry.policy.maxPartBytes) &&
        Number.isInteger(entry.policy.maxParts) &&
        (entry.policy.logToFile === undefined || typeof entry.policy.logToFile === 'boolean'),
    ) ||
    !finiteNumber(data.historySettings.maxTotalBytes) ||
    !finiteNumber(data.historySettings.minFreeBytes) ||
    !finiteNumber(data.historySettings.minFreePercent) ||
    (data.logFileSettings !== undefined &&
      (!isRecord(data.logFileSettings) ||
        !nonEmptyString(data.logFileSettings.filenamePattern) ||
        data.logFileSettings.filenamePattern.length > 200 ||
        typeof data.logFileSettings.timestamps !== 'boolean')) ||
    (data.folderSettings !== undefined &&
      (!boundedArray(data.folderSettings, 500) ||
        !data.folderSettings.every(
          (entry) =>
            isRecord(entry) &&
            nonEmptyString(entry.path) &&
            entry.path.length <= 300 &&
            isRecord(entry.auth),
        ))) ||
    (data.sharedSessionSources !== undefined &&
      (!boundedArray(data.sharedSessionSources, 200) ||
        !data.sharedSessionSources.every(
          (entry) =>
            isRecord(entry) &&
            nonEmptyString(entry.id) &&
            nonEmptyString(entry.name) &&
            nonEmptyString(entry.url) &&
            nonEmptyString(entry.folder) &&
            Number.isInteger(entry.refreshMinutes) &&
            finiteRange(entry.refreshMinutes, 0, MAX_SHARED_SESSIONS_REFRESH_MINUTES),
        ))) ||
    (data.passwordManagers !== undefined &&
      (!boundedArray(data.passwordManagers, 100) ||
        !data.passwordManagers.every(
          (entry) =>
            isRecord(entry) &&
            nonEmptyString(entry.id) &&
            nonEmptyString(entry.kind) &&
            typeof entry.name === 'string' &&
            isRecord(entry.config),
        ))) ||
    (data.workspaces !== undefined &&
      (!boundedArray(data.workspaces, 1_000) ||
        !data.workspaces.every(
          (entry) =>
            isRecord(entry) &&
            nonEmptyString(entry.id) &&
            nonEmptyString(entry.name) &&
            isRecord(entry.layout) &&
            Array.isArray(entry.multiExecGroups) &&
            typeof entry.isLocked === 'boolean' &&
            typeof entry.isStartup === 'boolean',
        ))) ||
    (data.scripts !== undefined &&
      (!boundedArray(data.scripts, 5_000) ||
        !data.scripts.every(
          (entry) =>
            isRecord(entry) &&
            nonEmptyString(entry.id) &&
            nonEmptyString(entry.name) &&
            typeof entry.body === 'string',
        ))) ||
    (data.managementRequests !== undefined &&
      (!boundedArray(data.managementRequests, 20_000) ||
        !data.managementRequests.every(
          (entry) =>
            isRecord(entry) &&
            nonEmptyString(entry.id) &&
            (entry.protocol === 'gnmi' || entry.protocol === 'netconf') &&
            (entry.profileId === undefined || nonEmptyString(entry.profileId)) &&
            nonEmptyString(entry.name) &&
            isRecord(entry.request),
        )))
  ) {
    throw new Error('The backup data is incomplete or too large.');
  }
  const ids = (entries: unknown, key = 'id'): string[] =>
    Array.isArray(entries)
      ? entries.map((entry) => String((entry as Record<string, unknown>)[key]))
      : [];
  const repeats = (values: readonly string[]): boolean => new Set(values).size !== values.length;
  if (
    repeats(ids(data.tunnels)) ||
    repeats(ids(data.loggingPolicies, 'profileKey')) ||
    repeats(ids(data.passwordManagers)) ||
    repeats(ids(data.workspaces)) ||
    repeats(ids(data.scripts)) ||
    repeats(ids(data.managementRequests))
  ) {
    throw new Error('The backup contains duplicate saved items.');
  }
}

function boundedArray(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validKeywordHighlight(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    (value.name === undefined ||
      (typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 100)) &&
    typeof value.keyword === 'string' &&
    value.keyword.length > 0 &&
    value.keyword.length <= 500 &&
    validHexColor(value.foreground) &&
    (value.background === undefined || validHexColor(value.background)) &&
    typeof value.caseSensitive === 'boolean' &&
    typeof value.wholeWord === 'boolean' &&
    (value.regex === undefined || typeof value.regex === 'boolean')
  );
}

function validHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
