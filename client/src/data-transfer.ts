import type {
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
import { saveTextFile } from './save-file.js';
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from './sidebar-width.js';
import { MIN_SFTP_PANEL_WIDTH } from './sftp-panel-width.js';
import { usePrefsStore, type PrefsState } from './state/prefs.js';

export const BACKUP_FORMAT = 'muxus-backup';
export const TRANSFER_VERSION = 1;
export const MAX_TRANSFER_FILE_BYTES = 20 * 1024 * 1024;

const JSON_HEADERS = { 'content-type': 'application/json' };

const PREFERENCE_KEYS = [
  'themeMode',
  'monoFontSize',
  'fontFamily',
  'lineHeight',
  'terminalScheme',
  'scrollback',
  'cursorBlink',
  'cursorStyle',
  'localShell',
  'copyOnSelect',
  'rightClickAction',
  'pasteWarnMultiline',
  'confirmCloseConnected',
  'commandButtons',
  'keywordHighlights',
  'sidebarCollapsed',
  'sidebarWidth',
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

export type PortableHistorySettings = Omit<
  SessionHistorySettings,
  'storageLocation'
>;

export interface MuxusBackupV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof TRANSFER_VERSION;
  createdAt: string;
  appVersion?: string;
  data: PortableConnections & {
    preferences: BackupPreferences;
    tunnels: TunnelRecord[];
    loggingPolicies: BackupLoggingPolicy[];
    historySettings: PortableHistorySettings;
  };
}

export type TransferDocument = MuxusBackupV1;
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
): Promise<MuxusBackupV1> {
  const snapshot = await fetchBaseSnapshot();
  const profileKeys = [
    '*',
    'local',
    ...snapshot.sshConfig.hosts.map((host) => `ssh:${host.alias}`),
    ...snapshot.savedHosts.map((profile) => `profile:${profile.id}`),
  ];
  const [policies, storage] = await Promise.all([
    Promise.all(
      profileKeys.map((profileKey) =>
        apiFetch<SessionLoggingPolicy>(
          `/api/session-history/policy?profileKey=${encodeURIComponent(profileKey)}`,
        ),
      ),
    ),
    apiFetch<SessionHistoryStorageStatus>('/api/session-history/storage'),
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
    },
  };
}

export async function createOpenSshExport(): Promise<string> {
  const { hosts } = await apiFetch<SshConfigResponse>('/api/ssh/config');
  const blocks = await Promise.all(
    hosts.map((host) =>
      fetchHostPreview({
        aliases: host.aliases,
        description: host.description,
        options: portableSshOptions(host),
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
  if (parsed.version !== TRANSFER_VERSION) {
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
  validateConnections(parsed.data);
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
    favorite: metadata.favorite,
    displayName,
    group: metadata.group,
    color: metadata.color,
    icon: metadata.icon,
    keywordHighlights: metadata.keywordHighlights,
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
  const sshByAlias = new Map(
    sshConfig.hosts.map((host) => [host.alias, host]),
  );
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

function metadataPatch(metadata: PortableHostMetadata): OpenSshMetadataPatch {
  return {
    favorite: metadata.favorite,
    displayName: metadata.displayName ?? null,
    group: metadata.group ?? null,
    color: metadata.color ?? null,
    icon: metadata.icon ?? null,
    keywordHighlights: metadata.keywordHighlights ?? null,
  };
}

function portableTunnelInput(tunnel: TunnelRecord): Omit<TunnelRecord, 'createdAt' | 'updatedAt'> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = tunnel;
  return input;
}

function sanitizePreferences(input: BackupPreferences): Partial<PrefsState> {
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
  if (
    typeof input.terminalScheme === 'string' &&
    input.terminalScheme.length <= 100
  ) {
    output.terminalScheme = input.terminalScheme;
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
  if (typeof input.localShell === 'string' && input.localShell.length <= 4096) {
    output.localShell = input.localShell;
  }
  if (typeof input.copyOnSelect === 'boolean') output.copyOnSelect = input.copyOnSelect;
  if (['copy-paste', 'paste', 'menu'].includes(input.rightClickAction)) {
    output.rightClickAction = input.rightClickAction;
  }
  if (typeof input.pasteWarnMultiline === 'boolean') {
    output.pasteWarnMultiline = input.pasteWarnMultiline;
  }
  if (typeof input.confirmCloseConnected === 'boolean') {
    output.confirmCloseConnected = input.confirmCloseConnected;
  }
  if (
    Array.isArray(input.commandButtons) &&
    input.commandButtons.length <= 100 &&
    input.commandButtons.every(validCommandButton)
  ) {
    output.commandButtons = input.commandButtons;
  }
  if (
    Array.isArray(input.keywordHighlights) &&
    input.keywordHighlights.length <= 100 &&
    input.keywordHighlights.every(validKeywordHighlight)
  ) {
    output.keywordHighlights = input.keywordHighlights;
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
  return output;
}

function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validateConnections(data: Record<string, unknown>): void {
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
        (host.profile.kind === 'telnet' || host.profile.kind === 'serial') &&
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
    !finiteNumber(data.historySettings.minFreePercent)
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
