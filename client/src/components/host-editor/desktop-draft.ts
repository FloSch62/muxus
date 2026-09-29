import type {
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
  SshGateway,
} from '@muxus/shared';
import { parseHostTarget } from './native-draft.js';

export type DesktopKind = 'rdp' | 'vnc';

export const DEFAULT_DESKTOP_PORTS: Readonly<Record<DesktopKind, number>> = {
  rdp: 3389,
  vnc: 5900,
};

/**
 * Form state for Muxus-owned RDP and VNC hosts. One draft serves both kinds
 * so switching the connection type while creating keeps what was typed; an
 * empty port follows the selected protocol's default.
 */
export interface DesktopHostDraft {
  name: string;
  group: string;
  color?: string;
  host: string;
  port: string;
  username: string;
  domain: string;
  /** SSH host the desktop is reached through; undefined connects directly. */
  sshGateway?: SshGateway;
  shareClipboard: boolean;
  resizeRemote: boolean;
  viewOnly: boolean;
}

export function blankDesktopDraft(prefillTarget = '', group = ''): DesktopHostDraft {
  const { host, port, user } = parseHostTarget(prefillTarget);
  return {
    name: '',
    group,
    color: undefined,
    host,
    port: port ?? '',
    username: user ?? '',
    domain: '',
    sshGateway: undefined,
    shareClipboard: true,
    resizeRemote: false,
    viewOnly: false,
  };
}

export function desktopDraftFromProfile(saved: SavedHostProfile, duplicate: boolean): DesktopHostDraft {
  const profile = saved.profile;
  if (profile.kind !== 'rdp' && profile.kind !== 'vnc') {
    throw new Error('saved host is not an RDP or VNC profile');
  }
  return {
    name: duplicate ? `${saved.name} copy` : saved.name,
    group: saved.metadata.group ?? '',
    color: saved.metadata.color,
    host: profile.host,
    port: profile.port === DEFAULT_DESKTOP_PORTS[profile.kind] ? '' : String(profile.port),
    username: profile.username ?? '',
    domain: profile.kind === 'rdp' ? (profile.domain ?? '') : '',
    sshGateway: profile.sshGateway,
    shareClipboard: profile.shareClipboard !== false,
    resizeRemote: profile.kind === 'vnc' && profile.resizeRemote === true,
    viewOnly: profile.kind === 'vnc' && profile.viewOnly === true,
  };
}

export function desktopDraftPort(draft: DesktopHostDraft, kind: DesktopKind): number {
  return draft.port.trim() ? Number(draft.port) : DEFAULT_DESKTOP_PORTS[kind];
}

export function desktopDraftProblem(draft: DesktopHostDraft, kind: DesktopKind): string | null {
  if (!draft.name.trim()) return 'A name is required — it labels this host in Muxus.';
  if (!draft.host.trim()) return 'Enter a hostname or IP address.';
  if (/\s/.test(draft.host.trim())) return 'The host cannot contain spaces.';
  const port = desktopDraftPort(draft, kind);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Port must be between 1 and 65535.';
  return null;
}

export function desktopDraftToInput(
  draft: DesktopHostDraft,
  kind: DesktopKind,
  existingId?: string,
): SavedHostProfileInput {
  const common = {
    host: draft.host.trim(),
    port: desktopDraftPort(draft, kind),
    ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
    ...(draft.sshGateway ? { sshGateway: draft.sshGateway } : {}),
    ...(draft.shareClipboard ? {} : { shareClipboard: false }),
  };
  return {
    id: existingId,
    name: draft.name.trim(),
    profile:
      kind === 'rdp'
        ? {
            kind: 'rdp',
            ...common,
            ...(draft.domain.trim() ? { domain: draft.domain.trim() } : {}),
          }
        : {
            kind: 'vnc',
            ...common,
            ...(draft.resizeRemote ? { resizeRemote: true } : {}),
            ...(draft.viewOnly ? { viewOnly: true } : {}),
          },
  };
}

/** Muxus-only metadata written right after the host itself saves. */
export function desktopDraftMetadataPatch(draft: DesktopHostDraft): OpenSshMetadataPatch {
  return {
    group: draft.group.trim() || null,
    color: draft.color ?? null,
  };
}
