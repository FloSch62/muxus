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

/** Everything the editor form holds, in form-friendly shapes (ports as text). */
export interface HostDraft {
  /** Space-separated aliases for the Host line (usually one). */
  aliasText: string;
  description: string;
  /** Muxus-only presentation metadata, saved alongside the block. */
  displayName: string;
  group: string;
  color?: string;
  /** Target config file; '' keeps the block's file (or the root for new hosts). */
  file: string;
  hostname: string;
  user: string;
  port: string;
  authMode: 'default' | 'key' | 'password';
  identityFiles: string[];
  certificateFiles: string[];
  identitiesOnly: boolean;
  forwardAgent: boolean;
  routeMode: 'direct' | 'jump' | 'command';
  proxyJump: string[];
  proxyCommand: string;
  forwards: ConfigForward[];
  extras: Array<{ keyword: string; value: string }>;
  keywordHighlights: HostKeywordHighlightConfig;
  sessionLogging: HostSessionLoggingDraft;
}

export function blankDraft(prefillTarget = ''): HostDraft {
  return {
    aliasText: prefillTarget,
    description: '',
    displayName: '',
    group: '',
    color: undefined,
    file: '',
    hostname: '',
    user: '',
    port: '',
    authMode: 'default',
    identityFiles: [],
    certificateFiles: [],
    identitiesOnly: false,
    forwardAgent: false,
    routeMode: 'direct',
    proxyJump: [],
    proxyCommand: '',
    forwards: [],
    extras: [],
    keywordHighlights: { inheritGlobal: true, rules: [] },
    sessionLogging: blankHostSessionLoggingDraft(),
  };
}

/** Build the form state from a listed entry's own block options. */
export function draftFromEntry(entry: SshHostEntry, duplicate: boolean): HostDraft {
  const o = entry.options;
  return {
    aliasText: duplicate ? `${entry.alias}-copy` : entry.aliases.join(' '),
    description: entry.description ?? '',
    displayName: duplicate ? '' : (entry.metadata?.displayName ?? ''),
    group: entry.metadata?.group ?? '',
    color: entry.metadata?.color,
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
    forwardAgent: o.forwardAgent ?? false,
    routeMode: o.proxyCommand
      ? 'command'
      : o.proxyJump?.length
        ? 'jump'
        : 'direct',
    proxyJump: o.proxyJump ?? [],
    proxyCommand: o.proxyCommand ?? '',
    forwards: o.forwards ?? [],
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
  if (draft.routeMode === 'command' && !draft.proxyCommand.trim()) {
    return 'Proxy command is required when ProxyCommand routing is selected.';
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
      identitiesOnly: draft.authMode === 'key' && draft.identitiesOnly ? true : undefined,
      forwardAgent: draft.forwardAgent ? true : undefined,
      proxyJump:
        draft.routeMode === 'jump' && draft.proxyJump.length
          ? draft.proxyJump
          : undefined,
      proxyCommand:
        draft.routeMode === 'command' ? text(draft.proxyCommand) : undefined,
      forwards: draft.forwards.length ? draft.forwards : undefined,
      passwordOnly: draft.authMode === 'password' ? true : undefined,
      extras: draft.extras.length ? draft.extras : undefined,
    },
  };
}
