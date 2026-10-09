import type {
  HostKeywordHighlightConfig,
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
  SerialProfile,
} from '@muxus/shared';
import { DEFAULT_BREAK_DURATION_MS, MAX_BREAK_DURATION_MS } from '@muxus/shared/ws-protocol';
import {
  blankHostSessionLoggingDraft,
  type HostSessionLoggingDraft,
} from '../../session-logging-policy.js';
import {
  loginSequenceDraft,
  loginSequenceFromDraft,
  loginSequenceProblem,
  type LoginSequenceDraft,
} from '../../login-sequence.js';
import { keywordHighlightRulesProblem } from '../../terminal/keyword-matching.js';

/**
 * Form state for Muxus-owned Telnet/serial hosts. One draft carries both
 * kinds so switching the connection type while creating never loses input.
 */
export interface NativeHostDraft {
  name: string;
  /** Muxus sidebar group, applied as a metadata patch after the host saves. */
  group: string;
  /** Muxus row color, applied with the same metadata patch. */
  color?: string;
  /** Empty follows the application theme's terminal scheme preference. */
  terminalScheme?: string;
  terminalFontColor?: string;
  terminalBackgroundColor?: string;
  /** Command button group the bar switches to in this host's sessions. */
  commandButtonGroup?: string;
  host: string;
  port: string;
  path: string;
  baudRate: string;
  dataBits: SerialProfile['dataBits'];
  stopBits: SerialProfile['stopBits'];
  parity: SerialProfile['parity'];
  flowControl: SerialProfile['flowControl'];
  /** Milliseconds Send BREAK holds a serial line. */
  breakDurationMs: string;
  keywordHighlights: HostKeywordHighlightConfig;
  sessionLogging: HostSessionLoggingDraft;
  loginSequence: LoginSequenceDraft;
}

export function blankNativeDraft(prefillTarget = '', group = ''): NativeHostDraft {
  const { host, port } = parseHostTarget(prefillTarget);
  return {
    name: '',
    group,
    color: undefined,
    terminalScheme: undefined,
    terminalFontColor: undefined,
    terminalBackgroundColor: undefined,
    commandButtonGroup: undefined,
    host,
    port: port ?? '23',
    path: '',
    baudRate: '115200',
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    breakDurationMs: String(DEFAULT_BREAK_DURATION_MS),
    keywordHighlights: { inheritGlobal: true, rules: [] },
    sessionLogging: blankHostSessionLoggingDraft(),
    loginSequence: loginSequenceDraft(undefined),
  };
}

export function nativeDraftFromProfile(saved: SavedHostProfile, duplicate: boolean): NativeHostDraft {
  const draft = blankNativeDraft();
  draft.name = duplicate ? `${saved.name} copy` : saved.name;
  draft.group = saved.metadata.group ?? '';
  draft.color = saved.metadata.color;
  draft.terminalScheme = saved.metadata.terminalScheme;
  draft.terminalFontColor = saved.metadata.terminalFontColor;
  draft.terminalBackgroundColor = saved.metadata.terminalBackgroundColor;
  draft.commandButtonGroup = saved.metadata.commandButtonGroup;
  draft.keywordHighlights = saved.metadata.keywordHighlights ?? draft.keywordHighlights;
  draft.loginSequence = loginSequenceDraft(saved.metadata.loginSequence);
  if (saved.profile.kind === 'telnet') {
    draft.host = saved.profile.host;
    draft.port = String(saved.profile.port);
  } else if (saved.profile.kind === 'serial') {
    draft.path = saved.profile.path;
    draft.baudRate = String(saved.profile.baudRate);
    draft.dataBits = saved.profile.dataBits;
    draft.stopBits = saved.profile.stopBits;
    draft.parity = saved.profile.parity;
    draft.flowControl = saved.profile.flowControl;
    draft.breakDurationMs = String(saved.profile.breakDurationMs ?? DEFAULT_BREAK_DURATION_MS);
  } else {
    throw new Error('saved host is not a Telnet or serial profile');
  }
  return draft;
}

export function nativeDraftProblem(draft: NativeHostDraft, kind: 'telnet' | 'serial'): string | null {
  if (!draft.name.trim()) return 'A name is required — it labels this host in Muxus.';
  if (kind === 'telnet') {
    if (!draft.host.trim()) return 'Enter a hostname or IP address.';
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Port must be between 1 and 65535.';
  } else {
    if (!draft.path.trim()) return 'Choose or enter a serial port.';
    const baud = Number(draft.baudRate);
    if (!Number.isInteger(baud) || baud < 1 || baud > 12_000_000) return 'Baud rate must be between 1 and 12000000.';
    const breakDuration = Number(draft.breakDurationMs);
    if (!Number.isInteger(breakDuration) || breakDuration < 1 || breakDuration > MAX_BREAK_DURATION_MS) {
      return `Break duration must be between 1 and ${MAX_BREAK_DURATION_MS} ms.`;
    }
  }
  return (
    loginSequenceProblem(draft.loginSequence) ??
    keywordHighlightRulesProblem(draft.keywordHighlights.rules)
  );
}

export function nativeDraftToInput(
  draft: NativeHostDraft,
  kind: 'telnet' | 'serial',
  existingId?: string,
): SavedHostProfileInput {
  return {
    id: existingId,
    name: draft.name.trim(),
    profile:
      kind === 'telnet'
        ? { kind: 'telnet', host: draft.host.trim(), port: Number(draft.port) }
        : {
            kind: 'serial',
            path: draft.path.trim(),
            baudRate: Number(draft.baudRate),
            dataBits: draft.dataBits,
            stopBits: draft.stopBits,
            parity: draft.parity,
            flowControl: draft.flowControl,
            breakDurationMs: Number(draft.breakDurationMs),
          },
  };
}

/** Muxus-only metadata written right after the host itself saves. */
export function nativeDraftMetadataPatch(draft: NativeHostDraft): OpenSshMetadataPatch {
  const highlights = draft.keywordHighlights;
  return {
    group: draft.group.trim() || null,
    color: draft.color ?? null,
    terminalScheme: draft.terminalScheme ?? null,
    terminalFontColor: draft.terminalFontColor ?? null,
    terminalBackgroundColor: draft.terminalBackgroundColor ?? null,
    commandButtonGroup: draft.commandButtonGroup ?? null,
    keywordHighlights:
      highlights.inheritGlobal && !highlights.profileId && highlights.rules.length === 0
        ? null
        : highlights,
    loginSequence: loginSequenceFromDraft(draft.loginSequence),
  };
}

/** Split a quick-connect target like user@host:port into form fields. */
export function parseHostTarget(target: string): {
  host: string;
  port?: string;
  user?: string;
} {
  const trimmed = target.trim();
  const withUser = /^([^@\s]+)@(.+)$/.exec(trimmed);
  const user = withUser?.[1];
  const stripped = withUser?.[2] ?? trimmed;
  const match = /^(.+):(\d{1,5})$/.exec(stripped);
  if (match?.[1] && match[2]) return { host: match[1], port: match[2], user };
  return { host: stripped, user };
}
