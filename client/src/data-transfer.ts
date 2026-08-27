import type {
  FolderAuthSettings,
  FolderSettingsRecord,
  FolderSettingsResponse,
  HostBlockOptions,
  HostUpsertRequest,
  ManagedHostRef,
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfilesResponse,
  SessionHistorySettings,
  SessionHistoryStorageStatus,
  SessionLoggingPolicy,
  SessionLoggingPolicyInput,
  SshConfigResponse,
  SshHostEntry,
  TunnelRecord,
  TunnelsResponse,
} from '@muxus/shared';
import { apiFetch } from './api/http.js';
import { fetchHostPreview } from './api/ssh-config.js';
import { isKeywordHighlightProfileArray } from './highlight-profiles.js';
import { saveTextFile } from './save-file.js';
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from './sidebar-width.js';
import { MIN_SFTP_PANEL_WIDTH } from './sftp-panel-width.js';
import {
  MAX_INACTIVE_PANE_DIM_STRENGTH,
  MIN_INACTIVE_PANE_DIM_STRENGTH,
  isLocalShellProfileArray,
  isTerminalFileLinkActivation,
  usePrefsStore,
  type FolderStyle,
  type PrefsState,
} from './state/prefs.js';
import { isFolderIconId } from './components/sidebar/folder-icons.js';

export const BACKUP_FORMAT = 'muxus-backup';
export const TRANSFER_VERSION = 2;
const LEGACY_TRANSFER_VERSION = 1;
export const MAX_TRANSFER_FILE_BYTES = 20 * 1024 * 1024;

const JSON_HEADERS = { 'content-type': 'application/json' };

const PREFERENCE_KEYS = [
  'themeMode',
  'monoFontSize',
  'fontFamily',
  'lineHeight',
  'lightTerminalScheme',
  'darkTerminalScheme',
  'fontColor',
  'backgroundColor',
  'activePaneBorder',
  'dimInactivePanes',
  'inactivePaneDimStrength',
  'scrollback',
  'cursorBlink',
  'cursorStyle',
  'webglRenderer',
  'localShell',
  'localShellProfiles',
  'defaultLocalShellProfileId',
  'copyOnSelect',
  'allowOsc52ClipboardWrite',
  'rightClickAction',
  'terminalFileLinkActivation',
  'pasteWarnMultiline',
  'confirmCloseConnected',
  'notifyOnNewVersion',
  'commandButtons',
  'showCommandBar',
  'keywordHighlights',
  'keywordHighlightProfiles',
  'sidebarCollapsed',
  'sidebarWidth',
  'sidebarCollapsedFolders',
  'sidebarFolderStyles',
  'sidebarFolderOrder',
  'sidebarEmptyFolders',
  'sftpPanelWidth',
] as const satisfies readonly (keyof PrefsState)[];

export type BackupPreferences = Pick<
  PrefsState,
  (typeof PREFERENCE_KEYS)[number]
>;

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
}

export type PortableHistorySettings = Omit<
  SessionHistorySettings,
  'storageLocation'
>;

export interface MuxusBackupData extends PortableConnections {
  preferences: BackupPreferences;
  tunnels: TunnelRecord[];
  loggingPolicies: BackupLoggingPolicy[];
  historySettings: PortableHistorySettings;
  /** Absent in backups from before folder credentials existed. */
  folderSettings?: PortableFolderSettings[];
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
  const [policies, storage, folderSettings] = await Promise.all([
    Promise.all(
      profileKeys.map((profileKey) =>
        apiFetch<SessionLoggingPolicy>(
          `/api/session-history/policy?profileKey=${encodeURIComponent(profileKey)}`,
        ),
      ),
    ),
    apiFetch<SessionHistoryStorageStatus>('/api/session-history/storage'),
    apiFetch<FolderSettingsResponse>('/api/folders/settings'),
  ]);
  const { storageLocation: _storageLocation, ...historySettings } =
    storage.settings;
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
        .map(({ profileKey, enabled, captureInput, maxPartBytes, maxParts }) => ({
          profileKey,
          policy: { enabled, captureInput, maxPartBytes, maxParts },
        })),
      historySettings,
      folderSettings: folderSettings.folders
        .filter((folder) => Object.keys(folder.auth).length > 0)
        .map(({ path, auth }) => ({ path, auth })),
    },
  };
}

export async function createOpenSshExport(): Promise<string> {
  const [{ hosts }, saved, folderSettings] = await Promise.all([
    apiFetch<SshConfigResponse>('/api/ssh/config'),
    apiFetch<SavedHostProfilesResponse>('/api/profiles'),
    apiFetch<FolderSettingsResponse>('/api/folders/settings'),
  ]);
  const usedAliases = new Set(hosts.flatMap((host) => host.aliases));
  const nativeSshHosts = saved.profiles.flatMap((profile) => {
    if (profile.profile.kind !== 'ssh') return [];
    const inherited = savedProfileFolderDefaults(
      profile.metadata.group,
      folderSettings.folders,
    );
    const base = openSshExportAlias(profile.name, profile.profile.target);
    let alias = base;
    let suffix = 2;
    while (usedAliases.has(alias)) alias = `${base}-${suffix++}`;
    usedAliases.add(alias);
    return [
      {
        aliases: [alias],
        description: inherited.hasPassword
          ? 'Exported from Muxus app data. Shared folder password omitted.'
          : 'Exported from Muxus app data.',
        options: portableSavedSshOptions(profile, inherited.auth),
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
    proxyJump: saved.proxyJump,
    proxyCommand: saved.proxyCommand,
    forwards: saved.forwards,
    passwordOnly: saved.passwordOnly,
    remoteCommand: saved.remoteCommand,
    requestTty: saved.requestTty,
    strictHostKeyChecking: saved.strictHostKeyChecking,
  };
}

/** Materialize the non-secret defaults the saved profile inherits in Muxus. */
function savedProfileFolderDefaults(
  group: string | undefined,
  folders: readonly FolderSettingsRecord[],
): { auth: FolderAuthSettings; hasPassword: boolean } {
  const parts = (group ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { auth: {}, hasPassword: false };

  const byPath = new Map(
    folders.map((folder) => [folder.path.toLocaleLowerCase(), folder]),
  );
  const auth: FolderAuthSettings = {};
  let hasPassword = false;
  for (let length = parts.length; length > 0; length--) {
    const folder = byPath.get(parts.slice(0, length).join('/').toLocaleLowerCase());
    if (!folder) continue;
    hasPassword ||= folder.hasPassword;
    if (auth.user === undefined) auth.user = folder.auth.user;
    if (auth.port === undefined) auth.port = folder.auth.port;
    if (auth.identityFiles === undefined) auth.identityFiles = folder.auth.identityFiles;
    if (auth.identitiesOnly === undefined) auth.identitiesOnly = folder.auth.identitiesOnly;
    if (auth.identityAgent === undefined) auth.identityAgent = folder.auth.identityAgent;
    if (auth.forwardAgent === undefined) auth.forwardAgent = folder.auth.forwardAgent;
  }
  return { auth, hasPassword };
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
    await restoreConnections(document.data, conflicts, result);
    await restoreFolderSettings(document.data.folderSettings ?? [], conflicts, result);
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
    const storage = await apiFetch<SessionHistoryStorageStatus>(
      '/api/session-history/storage',
    );
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
    ]);
    result.updated += document.data.loggingPolicies.length + 1;
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
    disableSftp: metadata.disableSftp,
    consoleCompatibility: metadata.consoleCompatibility,
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
      body: JSON.stringify({ path: entry.path, auth: entry.auth }),
    });
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
    disableSftp: metadata.disableSftp ?? false,
    consoleCompatibility: metadata.consoleCompatibility ?? false,
  };
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
  if (typeof input.confirmCloseConnected === 'boolean') {
    output.confirmCloseConnected = input.confirmCloseConnected;
  }
  if (typeof input.notifyOnNewVersion === 'boolean') {
    output.notifyOnNewVersion = input.notifyOnNewVersion;
  }
  if (
    Array.isArray(input.commandButtons) &&
    input.commandButtons.length <= 100 &&
    input.commandButtons.every(validCommandButton)
  ) {
    output.commandButtons = input.commandButtons;
  }
  if (typeof input.showCommandBar === 'boolean') {
    output.showCommandBar = input.showCommandBar;
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
  if (
    finiteRange(
      input.sidebarWidth,
      MIN_SIDEBAR_WIDTH,
      MAX_SIDEBAR_WIDTH,
    )
  ) {
    output.sidebarWidth = input.sidebarWidth;
  }
  if (finiteRange(input.sftpPanelWidth, MIN_SFTP_PANEL_WIDTH, 1200)) {
    output.sftpPanelWidth = input.sftpPanelWidth;
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
          (version >= 2 && host.profile.kind === 'ssh')) &&
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
        Number.isInteger(tunnel.bindPort),
    ) ||
    !data.loggingPolicies.every(
      (entry) =>
        isRecord(entry) &&
        nonEmptyString(entry.profileKey) &&
        isRecord(entry.policy) &&
        typeof entry.policy.enabled === 'boolean' &&
        typeof entry.policy.captureInput === 'boolean' &&
        Number.isInteger(entry.policy.maxPartBytes) &&
        Number.isInteger(entry.policy.maxParts),
    ) ||
    !finiteNumber(data.historySettings.maxTotalBytes) ||
    !finiteNumber(data.historySettings.minFreeBytes) ||
    !finiteNumber(data.historySettings.minFreePercent) ||
    (data.folderSettings !== undefined &&
      (!boundedArray(data.folderSettings, 500) ||
        !data.folderSettings.every(
          (entry) =>
            isRecord(entry) &&
            nonEmptyString(entry.path) &&
            entry.path.length <= 300 &&
            isRecord(entry.auth),
        )))
  ) {
    throw new Error('The backup data is incomplete or too large.');
  }
  const tunnelIds = data.tunnels.map((tunnel) =>
    String((tunnel as Record<string, unknown>).id),
  );
  const policyKeys = data.loggingPolicies.map((entry) =>
    String((entry as Record<string, unknown>).profileKey),
  );
  if (
    new Set(tunnelIds).size !== tunnelIds.length ||
    new Set(policyKeys).size !== policyKeys.length
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

function validCommandButton(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    typeof value.label === 'string' &&
    value.label.length <= 200 &&
    typeof value.command === 'string' &&
    value.command.length <= 100_000 &&
    typeof value.sendEnter === 'boolean'
  );
}

function validKeywordHighlight(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    typeof value.keyword === 'string' &&
    value.keyword.length > 0 &&
    value.keyword.length <= 500 &&
    validHexColor(value.foreground) &&
    (value.background === undefined || validHexColor(value.background)) &&
    typeof value.caseSensitive === 'boolean' &&
    typeof value.wholeWord === 'boolean'
  );
}

function validHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
