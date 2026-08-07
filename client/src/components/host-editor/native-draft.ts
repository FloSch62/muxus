import type {
  HostKeywordHighlightConfig,
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
  SerialProfile,
} from '@muxus/shared';
import {
  blankHostSessionLoggingDraft,
  type HostSessionLoggingDraft,
} from '../../session-logging-policy.js';

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
  host: string;
  port: string;
  path: string;
  baudRate: string;
  dataBits: SerialProfile['dataBits'];
  stopBits: SerialProfile['stopBits'];
  parity: SerialProfile['parity'];
  flowControl: SerialProfile['flowControl'];
  keywordHighlights: HostKeywordHighlightConfig;
  sessionLogging: HostSessionLoggingDraft;
}

export function blankNativeDraft(prefillTarget = ''): NativeHostDraft {
  const { host, port } = parseHostTarget(prefillTarget);
  return {
    name: '',
    group: '',
    color: undefined,
    host,
    port: port ?? '23',
    path: '',
    baudRate: '115200',
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    keywordHighlights: { inheritGlobal: true, rules: [] },
    sessionLogging: blankHostSessionLoggingDraft(),
  };
}

export function nativeDraftFromProfile(saved: SavedHostProfile, duplicate: boolean): NativeHostDraft {
  const draft = blankNativeDraft();
  draft.name = duplicate ? `${saved.name} copy` : saved.name;
  draft.group = saved.metadata.group ?? '';
  draft.color = saved.metadata.color;
  draft.keywordHighlights = saved.metadata.keywordHighlights ?? draft.keywordHighlights;
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
    return null;
  }
  if (!draft.path.trim()) return 'Choose or enter a serial port.';
  const baud = Number(draft.baudRate);
  if (!Number.isInteger(baud) || baud < 1 || baud > 12_000_000) return 'Baud rate must be between 1 and 12000000.';
  return null;
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
          },
  };
}

/** Muxus-only metadata written right after the host itself saves. */
export function nativeDraftMetadataPatch(draft: NativeHostDraft): OpenSshMetadataPatch {
  const highlights = draft.keywordHighlights;
  return {
    group: draft.group.trim() || null,
    color: draft.color ?? null,
    keywordHighlights:
      highlights.inheritGlobal && !highlights.profileId && highlights.rules.length === 0
        ? null
        : highlights,
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
