import type {
  HostKeywordHighlightConfig,
  HostOptionsPatch,
  OpenSshMetadataPatch,
  SavedHostProfileInput,
  SessionLoggingPolicy,
  SessionLoggingPolicyInput,
  SshProfile,
} from '@muxus/shared';
import {
  folderDepth,
  MAX_FOLDER_DEPTH,
  MAX_GROUP_PATH,
  normalizeGroupPath,
} from './host-tree.js';
import {
  loginSequenceDraft,
  loginSequenceFromDraft,
  loginSequenceProblem,
  sameLoginSequenceDraft,
  type LoginSequenceDraft,
} from './login-sequence.js';
import { managedHostKey, type ManagedHost } from './managed-hosts.js';
import {
  hostSessionLoggingDraft,
  sameSessionLoggingDraft,
  sessionLoggingPolicyInput,
  type HostSessionLoggingDraft,
} from './session-logging-policy.js';

/** An optional flag: unset follows the defaults, otherwise on or off. */
export type BulkTriState = 'inherit' | 'yes' | 'no';
export type BulkStrictHostKeyChecking = 'inherit' | 'yes' | 'no' | 'accept-new' | 'ask';

/**
 * Every setting the bulk editor can change, in the shape its control edits.
 * Each one maps onto a single stored value, so applying it to a host leaves
 * everything else about that host exactly as it was.
 */
export interface BulkHostValues {
  group: string;
  color: string | undefined;
  user: string;
  port: string;
  strictHostKeyChecking: BulkStrictHostKeyChecking;
  forwardAgent: BulkTriState;
  forwardX11: BulkTriState;
  consoleCompatibility: boolean;
  disableSftp: boolean;
  terminalScheme: string | undefined;
  terminalFontColor: string | undefined;
  terminalBackgroundColor: string | undefined;
  commandButtonGroup: string | undefined;
  pasteLineDelayMs: number | undefined;
  pasteCharDelayMs: number | undefined;
  highlightProfileId: string | undefined;
  highlightInheritGlobal: boolean;
  sessionLogging: HostSessionLoggingDraft;
  loginSequence: LoginSequenceDraft;
}

export type BulkHostField = keyof BulkHostValues;

/**
 * The fields the user changed; every absent key is left alone. A present key
 * may hold undefined — an unset color or scheme is a value to apply.
 */
export type BulkHostChanges = Partial<BulkHostValues>;

/** Which hosts a field means anything for. */
export type BulkAudience = 'all' | 'terminal' | 'ssh';

export const BULK_FIELD_AUDIENCE: { readonly [F in BulkHostField]: BulkAudience } = {
  group: 'all',
  color: 'all',
  user: 'ssh',
  port: 'ssh',
  strictHostKeyChecking: 'ssh',
  forwardAgent: 'ssh',
  forwardX11: 'ssh',
  consoleCompatibility: 'ssh',
  disableSftp: 'ssh',
  terminalScheme: 'terminal',
  terminalFontColor: 'terminal',
  terminalBackgroundColor: 'terminal',
  commandButtonGroup: 'terminal',
  pasteLineDelayMs: 'terminal',
  pasteCharDelayMs: 'terminal',
  highlightProfileId: 'terminal',
  highlightInheritGlobal: 'terminal',
  sessionLogging: 'terminal',
  loginSequence: 'terminal',
};

const CONNECTION_FIELDS = [
  'user',
  'port',
  'strictHostKeyChecking',
  'forwardAgent',
  'forwardX11',
] as const satisfies readonly BulkHostField[];

/** Whether a host is reached over SSH, from either host source. */
export function isSshHost(host: ManagedHost): boolean {
  return host.kind === 'ssh' || host.entry.profile.kind === 'ssh';
}

/** Whether a host opens a terminal: SSH, Telnet or serial, not a remote desktop. */
export function isTerminalHost(host: ManagedHost): boolean {
  return (
    isSshHost(host) ||
    (host.kind === 'profile' &&
      (host.entry.profile.kind === 'telnet' || host.entry.profile.kind === 'serial'))
  );
}

export function bulkFieldApplies(host: ManagedHost, field: BulkHostField): boolean {
  switch (BULK_FIELD_AUDIENCE[field]) {
    case 'ssh':
      return isSshHost(host);
    case 'terminal':
      return isTerminalHost(host);
    default:
      return true;
  }
}

/** Where a host's session logging override is stored — the same key the host editors use. */
export function hostLoggingKey(host: ManagedHost): string {
  return managedHostKey(host);
}

/**
 * One host's current values for the fields that apply to it. Session logging
 * is only known once its policy has loaded; until then it stays undefined.
 */
export function bulkValuesForHost(
  host: ManagedHost,
  logging?: SessionLoggingPolicy,
): Partial<BulkHostValues> {
  const metadata = host.entry.metadata;
  const values: Partial<BulkHostValues> = {
    group: normalizeGroupPath(metadata?.group),
    color: metadata?.color,
  };
  if (isTerminalHost(host)) {
    const highlights = metadata?.keywordHighlights;
    values.terminalScheme = metadata?.terminalScheme;
    values.terminalFontColor = metadata?.terminalFontColor;
    values.terminalBackgroundColor = metadata?.terminalBackgroundColor;
    values.commandButtonGroup = metadata?.commandButtonGroup;
    values.pasteLineDelayMs = metadata?.pasteLineDelayMs;
    values.pasteCharDelayMs = metadata?.pasteCharDelayMs;
    values.highlightProfileId = highlights?.profileId;
    values.highlightInheritGlobal = highlights?.inheritGlobal ?? true;
    values.loginSequence = loginSequenceDraft(metadata?.loginSequence);
    if (logging) values.sessionLogging = hostSessionLoggingDraft(logging, !logging.overridden);
  }
  const options = sshOptions(host);
  if (options) {
    values.user = options.user ?? '';
    values.port = options.port?.toString() ?? '';
    values.strictHostKeyChecking = options.strictHostKeyChecking ?? 'inherit';
    values.forwardAgent = triState(options.forwardAgent);
    values.forwardX11 = triState(options.forwardX11);
    values.consoleCompatibility = metadata?.consoleCompatibility ?? false;
    values.disableSftp = metadata?.disableSftp ?? false;
  }
  return values;
}

/** The connection options a host stores itself: its Host block, or its saved profile. */
function sshOptions(host: ManagedHost): Pick<
  SshProfile,
  'user' | 'port' | 'strictHostKeyChecking' | 'forwardAgent' | 'forwardX11'
> | undefined {
  if (host.kind === 'ssh') return host.entry.options;
  return host.entry.profile.kind === 'ssh' ? host.entry.profile : undefined;
}

function triState(value: boolean | undefined): BulkTriState {
  return value === undefined ? 'inherit' : value ? 'yes' : 'no';
}

function triStateOption(value: BulkTriState): boolean | null {
  return value === 'inherit' ? null : value === 'yes';
}

export function sameBulkValue<F extends BulkHostField>(
  field: F,
  a: BulkHostValues[F],
  b: BulkHostValues[F],
): boolean {
  if (field === 'sessionLogging') {
    return sameSessionLoggingDraft(a as HostSessionLoggingDraft, b as HostSessionLoggingDraft);
  }
  if (field === 'loginSequence') {
    return sameLoginSequenceDraft(a as LoginSequenceDraft, b as LoginSequenceDraft);
  }
  return a === b;
}

/** What the selection holds for one field. */
export type BulkFieldSummary<T> =
  /** No selected host has this setting (a remote desktop has no terminal colors). */
  | { state: 'none' }
  /** Not every host's value has arrived yet. */
  | { state: 'loading'; count: number }
  | { state: 'same'; count: number; value: T }
  | { state: 'mixed'; count: number };

export type BulkSummary = { [F in BulkHostField]: BulkFieldSummary<BulkHostValues[F]> };

const BULK_FIELDS = Object.keys(BULK_FIELD_AUDIENCE) as BulkHostField[];

/**
 * Per field, whether the selected hosts agree. `policies` holds the session
 * logging policies loaded so far, by `hostLoggingKey`.
 */
export function summarizeBulkValues(
  hosts: readonly ManagedHost[],
  policies: ReadonlyMap<string, SessionLoggingPolicy>,
): BulkSummary {
  const perHost = hosts.map((host) => ({
    host,
    values: bulkValuesForHost(host, policies.get(hostLoggingKey(host))),
  }));
  const summarize = <F extends BulkHostField>(field: F): BulkFieldSummary<BulkHostValues[F]> => {
    const applicable = perHost.filter(({ host }) => bulkFieldApplies(host, field));
    if (applicable.length === 0) return { state: 'none' };
    const count = applicable.length;
    // `in` rather than `!== undefined`: an unset color is a value, an unloaded policy is not.
    if (applicable.some(({ values }) => !(field in values))) return { state: 'loading', count };
    const first = applicable[0]!.values[field] as BulkHostValues[F];
    return applicable.every(({ values }) =>
      sameBulkValue(field, values[field] as BulkHostValues[F], first),
    )
      ? { state: 'same', count, value: first }
      : { state: 'mixed', count };
  };
  return Object.fromEntries(BULK_FIELDS.map((field) => [field, summarize(field)])) as BulkSummary;
}

/** Why the changes cannot be applied yet, if anything stops them. */
export function bulkChangesProblem(changes: BulkHostChanges): string | null {
  if (changes.group !== undefined) {
    const group = normalizeGroupPath(changes.group);
    if (group.length > MAX_GROUP_PATH) return `That folder path is longer than ${MAX_GROUP_PATH} characters.`;
    if (folderDepth(group) > MAX_FOLDER_DEPTH) return `Folders can nest ${MAX_FOLDER_DEPTH} levels deep.`;
  }
  if (changes.user !== undefined && /[\r\n"]/.test(changes.user)) {
    return 'The user name cannot contain quotes or line breaks.';
  }
  if (changes.port !== undefined && changes.port.trim()) {
    const port = Number(changes.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Port must be 1–65535.';
  }
  if (changes.loginSequence) return loginSequenceProblem(changes.loginSequence);
  return null;
}

/** Changes in their stored form, so they compare equal to what hosts already hold. */
function normalizeChanges(changes: BulkHostChanges): BulkHostChanges {
  const next = { ...changes };
  if (next.group !== undefined) next.group = normalizeGroupPath(next.group);
  if (next.user !== undefined) next.user = next.user.trim();
  if (next.port !== undefined) next.port = next.port.trim() ? String(Number(next.port)) : '';
  return next;
}

export interface BulkEditPlan {
  /** One patch for every OpenSSH host whose Host block changes. */
  openSsh?: { aliases: string[]; options: HostOptionsPatch };
  /** Muxus-owned SSH hosts, saved whole with the same options patched in. */
  profiles: SavedHostProfileInput[];
  metadata: Array<{ host: ManagedHost; patch: OpenSshMetadataPatch }>;
  logging: Array<{ profileKey: string; policy: SessionLoggingPolicyInput | null }>;
  /** Hosts that end up different; a host that already has every value is skipped. */
  hosts: ManagedHost[];
  /** Per changed field, how many hosts it actually changes. */
  fieldCounts: Partial<Record<BulkHostField, number>>;
}

/**
 * Turn the changed fields into the writes that apply them. A host only gets
 * the fields that apply to it and that it does not already have, and only
 * the stored values behind those fields change.
 */
export function bulkEditPlan(
  hosts: readonly ManagedHost[],
  rawChanges: BulkHostChanges,
  policies: ReadonlyMap<string, SessionLoggingPolicy> = new Map(),
): BulkEditPlan {
  const changes = normalizeChanges(rawChanges);
  const fields = Object.keys(changes) as BulkHostField[];
  const options = connectionPatch(changes);
  const plan: BulkEditPlan = { profiles: [], metadata: [], logging: [], hosts: [], fieldCounts: {} };
  for (const field of fields) plan.fieldCounts[field] = 0;
  const openSshAliases: string[] = [];

  for (const host of hosts) {
    const current = bulkValuesForHost(host, policies.get(hostLoggingKey(host)));
    const differs = new Set(
      fields.filter(
        (field) => bulkFieldApplies(host, field) && fieldDiffers(field, current, changes),
      ),
    );
    if (differs.size === 0) continue;
    plan.hosts.push(host);
    for (const field of differs) plan.fieldCounts[field] = (plan.fieldCounts[field] ?? 0) + 1;

    if (CONNECTION_FIELDS.some((field) => differs.has(field))) {
      if (host.kind === 'ssh') openSshAliases.push(host.entry.alias);
      else if (host.entry.profile.kind === 'ssh') {
        plan.profiles.push({
          id: host.entry.id,
          name: host.entry.name,
          profile: applyOptionsPatch(host.entry.profile, options),
        });
      }
    }

    const patch = metadataPatch(host, changes, differs);
    if (Object.keys(patch).length > 0) plan.metadata.push({ host, patch });

    if (differs.has('sessionLogging') && changes.sessionLogging) {
      plan.logging.push({
        profileKey: hostLoggingKey(host),
        policy: changes.sessionLogging.inherit
          ? null
          : sessionLoggingPolicyInput(changes.sessionLogging),
      });
    }
  }

  if (openSshAliases.length > 0) plan.openSsh = { aliases: openSshAliases, options };
  return plan;
}

function fieldDiffers<F extends BulkHostField>(
  field: F,
  current: Partial<BulkHostValues>,
  changes: BulkHostChanges,
): boolean {
  // An unloaded policy counts as different, so a host is never skipped by mistake.
  if (!(field in current)) return true;
  return !sameBulkValue(field, current[field] as BulkHostValues[F], changes[field] as BulkHostValues[F]);
}

function connectionPatch(changes: BulkHostChanges): HostOptionsPatch {
  const patch: HostOptionsPatch = {};
  if (changes.user !== undefined) patch.user = changes.user || null;
  if (changes.port !== undefined) patch.port = changes.port ? Number(changes.port) : null;
  if (changes.strictHostKeyChecking !== undefined) {
    patch.strictHostKeyChecking =
      changes.strictHostKeyChecking === 'inherit' ? null : changes.strictHostKeyChecking;
  }
  if (changes.forwardAgent !== undefined) patch.forwardAgent = triStateOption(changes.forwardAgent);
  if (changes.forwardX11 !== undefined) patch.forwardX11 = triStateOption(changes.forwardX11);
  return patch;
}

/** The profile with each patched option set, or removed for null. */
function applyOptionsPatch(profile: SshProfile, patch: HostOptionsPatch): SshProfile {
  const next: Record<string, unknown> = { ...profile };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as SshProfile;
}

function metadataPatch(
  host: ManagedHost,
  changes: BulkHostChanges,
  differs: ReadonlySet<BulkHostField>,
): OpenSshMetadataPatch {
  const patch: OpenSshMetadataPatch = {};
  if (differs.has('group')) patch.group = changes.group || null;
  if (differs.has('color')) patch.color = changes.color ?? null;
  if (differs.has('terminalScheme')) patch.terminalScheme = changes.terminalScheme ?? null;
  if (differs.has('terminalFontColor')) patch.terminalFontColor = changes.terminalFontColor ?? null;
  if (differs.has('terminalBackgroundColor')) {
    patch.terminalBackgroundColor = changes.terminalBackgroundColor ?? null;
  }
  if (differs.has('commandButtonGroup')) {
    patch.commandButtonGroup = changes.commandButtonGroup ?? null;
  }
  if (differs.has('pasteLineDelayMs')) patch.pasteLineDelayMs = changes.pasteLineDelayMs ?? null;
  if (differs.has('pasteCharDelayMs')) patch.pasteCharDelayMs = changes.pasteCharDelayMs ?? null;
  if (differs.has('consoleCompatibility')) patch.consoleCompatibility = changes.consoleCompatibility;
  if (differs.has('disableSftp')) patch.disableSftp = changes.disableSftp;
  if (differs.has('loginSequence') && changes.loginSequence) {
    patch.loginSequence = loginSequenceFromDraft(changes.loginSequence);
  }
  if (differs.has('highlightProfileId') || differs.has('highlightInheritGlobal')) {
    patch.keywordHighlights = patchedHighlights(host.entry.metadata?.keywordHighlights, changes, differs);
  }
  return patch;
}

/**
 * The host's highlighting with only the profile and the global switch
 * changed — its own rules always stay. Null when the result is the default,
 * which is how the host editors store it too.
 */
function patchedHighlights(
  current: HostKeywordHighlightConfig | undefined,
  changes: BulkHostChanges,
  differs: ReadonlySet<BulkHostField>,
): HostKeywordHighlightConfig | null {
  const next: HostKeywordHighlightConfig = { ...(current ?? { inheritGlobal: true, rules: [] }) };
  if (differs.has('highlightProfileId')) {
    if (changes.highlightProfileId) next.profileId = changes.highlightProfileId;
    else delete next.profileId;
  }
  if (differs.has('highlightInheritGlobal') && changes.highlightInheritGlobal !== undefined) {
    next.inheritGlobal = changes.highlightInheritGlobal;
  }
  return next.inheritGlobal && !next.profileId && next.rules.length === 0 ? null : next;
}
