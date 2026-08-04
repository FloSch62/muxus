import type {
  ConfigForward,
  HostKeywordHighlightConfig,
  HostUpsertRequest,
  SshHostEntry,
} from '@muxus/shared';
import {
  blankHostSessionLoggingDraft,
  type HostSessionLoggingDraft,
} from '../../session-logging-policy.js';
import { parseHostTarget } from './native-draft.js';

export type IdentityAgentMode = 'default' | 'environment' | 'custom' | 'none';
export type RemoteCommandMode = 'inherit' | 'shell' | 'command';
export type RequestTtyMode = 'inherit' | 'no' | 'yes' | 'force' | 'auto';
export type StrictHostKeyCheckingMode = 'inherit' | 'yes' | 'no' | 'accept-new' | 'ask';

/** Everything the editor form holds, in form-friendly shapes (ports as text). */
export interface HostDraft {
  /** Space-separated aliases for the Host line (usually one). */
  aliasText: string;
  description: string;
  /** Muxus-only presentation metadata, saved alongside the block. */
  displayName: string;
  group: string;
  color?: string;
  /** Muxus-only console compatibility: no SFTP, shell integration, or env requests. */
  disableSftp: boolean;
  /** Target config file; '' keeps the block's file (or the root for new hosts). */
  file: string;
  hostname: string;
  user: string;
  port: string;
  authMode: 'default' | 'key' | 'password';
  identityFiles: string[];
  certificateFiles: string[];
  identitiesOnly: boolean;
  identityAgentMode: IdentityAgentMode;
  /** Custom agent socket path or environment indirection. */
  identityAgent: string;
  forwardAgent: boolean;
  routeMode: 'direct' | 'jump' | 'command';
  proxyJump: string[];
  proxyCommand: string;
  forwards: ConfigForward[];
  remoteCommandMode: RemoteCommandMode;
  remoteCommand: string;
  requestTty: RequestTtyMode;
  strictHostKeyChecking: StrictHostKeyCheckingMode;
  extras: Array<{ keyword: string; value: string }>;
  keywordHighlights: HostKeywordHighlightConfig;
  sessionLogging: HostSessionLoggingDraft;
}

export function blankDraft(prefillTarget = ''): HostDraft {
  // A quick-connect target already carries the fields the form asks for; a bare
  // name the sidebar could not find is just the alias.
  const target = prefillTarget.trim();
  const parsed = /[@:]/.test(target) ? parseHostTarget(target) : undefined;
  return {
    aliasText: parsed?.host ?? target,
    description: '',
    displayName: '',
    group: '',
    color: undefined,
    disableSftp: false,
    file: '',
    hostname: parsed?.host ?? '',
    user: parsed?.user ?? '',
    port: parsed?.port ?? '',
    authMode: 'default',
    identityFiles: [],
    certificateFiles: [],
    // "Specific key file" is an exact-key mode. This stays dormant while the
    // default auth mode is selected, then serializes as IdentitiesOnly yes.
    identitiesOnly: true,
    identityAgentMode: 'default',
    identityAgent: '',
    forwardAgent: false,
    routeMode: 'direct',
    proxyJump: [],
    proxyCommand: '',
    forwards: [],
    remoteCommandMode: 'inherit',
    remoteCommand: '',
    requestTty: 'inherit',
    strictHostKeyChecking: 'inherit',
    extras: [],
    keywordHighlights: { inheritGlobal: true, rules: [] },
    sessionLogging: blankHostSessionLoggingDraft(),
  };
}

/** Build the form state from a listed entry's own block options. */
export function draftFromEntry(entry: SshHostEntry, duplicate: boolean): HostDraft {
  const o = entry.options;
  const identityAgent = identityAgentDraft(o.identityAgent);
  const remoteCommand = remoteCommandDraft(o.remoteCommand);
  return {
    aliasText: duplicate ? `${entry.alias}-copy` : entry.aliases.join(' '),
    description: entry.description ?? '',
    displayName: duplicate ? '' : (entry.metadata?.displayName ?? ''),
    group: entry.metadata?.group ?? '',
    color: entry.metadata?.color,
    disableSftp: entry.metadata?.disableSftp ?? false,
    file: entry.file,
    hostname: o.hostname ?? '',
    user: o.user ?? '',
    port: o.port?.toString() ?? '',
    authMode:
      o.passwordOnly
        ? 'password'
        : (o.identityFiles?.length || o.certificateFiles?.length)
          ? 'key'
          : 'default',
    identityFiles: o.identityFiles ?? [],
    certificateFiles: o.certificateFiles ?? [],
    identitiesOnly: o.identitiesOnly ?? false,
    identityAgentMode: identityAgent.mode,
    identityAgent: identityAgent.value,
    forwardAgent: o.forwardAgent ?? false,
    routeMode: o.proxyCommand
      ? 'command'
      : o.proxyJump?.length
        ? 'jump'
        : 'direct',
    proxyJump: o.proxyJump ?? [],
    proxyCommand: o.proxyCommand ?? '',
    forwards: o.forwards ?? [],
    remoteCommandMode: remoteCommand.mode,
    remoteCommand: remoteCommand.value,
    requestTty: o.requestTty ?? 'inherit',
    strictHostKeyChecking: o.strictHostKeyChecking ?? 'inherit',
    extras: o.extras ?? [],
    keywordHighlights: entry.metadata?.keywordHighlights ?? {
      inheritGlobal: true,
      rules: [],
    },
    sessionLogging: blankHostSessionLoggingDraft(),
  };
}

export function draftAliases(draft: HostDraft): string[] {
  return draft.aliasText.trim().split(/\s+/).filter(Boolean);
}

const ALIAS_RE = /^[^\s#*?!]+$/;

export function draftProblem(draft: HostDraft): string | null {
  const aliases = draftAliases(draft);
  if (!aliases.length) return 'An alias is required — it is what you connect as.';
  for (const a of aliases) {
    if (!ALIAS_RE.test(a)) return `"${a}" is not a valid alias (no spaces, wildcards or "!").`;
  }
  if (draft.port && !portOk(draft.port)) return 'Port must be 1–65535.';
  if (draft.authMode === 'key' && !draft.identityFiles.some((f) => f.trim())) return 'Pick at least one key file, or switch the auth mode.';
  if (draft.identityAgentMode === 'custom' && !draft.identityAgent.trim()) {
    return 'Enter an agent socket path or choose another agent source.';
  }
  if (draft.routeMode === 'command' && !draft.proxyCommand.trim()) {
    return 'Proxy command is required when ProxyCommand routing is selected.';
  }
  if (draft.remoteCommandMode === 'command' && !draft.remoteCommand.trim()) {
    return 'Enter a startup command or choose a login shell.';
  }
  for (const f of draft.forwards) {
    if (!portOk(String(f.bindPort))) return 'Every forward needs a listen port (1–65535).';
    if (f.type !== 'dynamic' && (!f.targetHost?.trim() || !portOk(String(f.targetPort ?? '')))) return 'Local/remote forwards need a target host and port.';
  }
  for (const e of draft.extras) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(e.keyword)) return `"${e.keyword}" is not a valid option keyword.`;
  }
  if (draft.keywordHighlights.rules.some((rule) => !rule.keyword.trim())) {
    return 'Every highlighting rule needs a keyword.';
  }
  return null;
}

function portOk(v: string): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536;
}

export function draftToRequest(draft: HostDraft, previousAlias?: string): HostUpsertRequest {
  const text = (v: string) => (v.trim() ? v.trim() : undefined);
  return {
    aliases: draftAliases(draft),
    description: text(draft.description),
    file: draft.file || undefined,
    previousAlias,
    options: {
      hostname: text(draft.hostname),
      user: text(draft.user),
      port: draft.port ? Number(draft.port) : undefined,
      identityFiles: draft.authMode === 'key' ? draft.identityFiles.map((f) => f.trim()).filter(Boolean) : undefined,
      certificateFiles:
        draft.authMode === 'key'
          ? draft.certificateFiles.map((f) => f.trim()).filter(Boolean)
          : undefined,
      // This editor mode promises that only the selected files are offered.
      // OpenSSH still tries the agent first for IdentityFile alone, so the
      // promise requires IdentitiesOnly yes.
      identitiesOnly: draft.authMode === 'key' ? true : undefined,
      identityAgent:
        draft.identityAgentMode === 'environment'
          ? 'SSH_AUTH_SOCK'
          : draft.identityAgentMode === 'none'
            ? 'none'
            : draft.identityAgentMode === 'custom'
              ? text(draft.identityAgent)
              : undefined,
      forwardAgent: draft.forwardAgent ? true : undefined,
      proxyJump:
        draft.routeMode === 'jump' && draft.proxyJump.length
          ? draft.proxyJump
          : undefined,
      proxyCommand:
        draft.routeMode === 'command' ? text(draft.proxyCommand) : undefined,
      forwards: draft.forwards.length ? draft.forwards : undefined,
      passwordOnly: draft.authMode === 'password' ? true : undefined,
      remoteCommand:
        draft.remoteCommandMode === 'shell'
          ? 'none'
          : draft.remoteCommandMode === 'command'
            ? text(draft.remoteCommand)
            : undefined,
      requestTty: draft.requestTty === 'inherit' ? undefined : draft.requestTty,
      strictHostKeyChecking:
        draft.strictHostKeyChecking === 'inherit'
          ? undefined
          : draft.strictHostKeyChecking,
      extras: draft.extras.length ? draft.extras : undefined,
    },
  };
}

/** Agent source represented by the current editor state, for live key detection. */
export function identityAgentForDetection(
  draft: Pick<HostDraft, 'identityAgentMode' | 'identityAgent'>,
  inheritedIdentityAgent?: string,
): string | undefined {
  switch (draft.identityAgentMode) {
    case 'environment':
      return 'SSH_AUTH_SOCK';
    case 'custom':
      // Do not accidentally scan the default agent while the custom field is empty.
      return draft.identityAgent.trim() || 'none';
    case 'none':
      return 'none';
    default:
      return inheritedIdentityAgent;
  }
}

function identityAgentDraft(value: string | undefined): {
  mode: IdentityAgentMode;
  value: string;
} {
  if (value === undefined) return { mode: 'default', value: '' };
  if (value === 'SSH_AUTH_SOCK') return { mode: 'environment', value: '' };
  if (value.toLowerCase() === 'none') return { mode: 'none', value: '' };
  return { mode: 'custom', value };
}

function remoteCommandDraft(value: string | undefined): {
  mode: RemoteCommandMode;
  value: string;
} {
  if (value === undefined) return { mode: 'inherit', value: '' };
  if (value.toLowerCase() === 'none') return { mode: 'shell', value: '' };
  return { mode: 'command', value };
}
