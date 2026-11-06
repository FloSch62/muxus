import type {
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
  SshGateway,
} from '@muxus/shared';
import { parseHostTarget } from './native-draft.js';
import { savedGatewayFallbacks } from './SshGatewayRouteField.js';

export const WINRM_PORTS = { http: 5985, https: 5986 } as const;

/** Form state for a saved WinRM shell. */
export interface WinrmHostDraft {
  name: string;
  group: string;
  color?: string;
  host: string;
  /** Empty follows HTTP (5985) or HTTPS (5986). */
  port: string;
  https: boolean;
  tlsVerify: 'verify' | 'skip-verify';
  auth: 'negotiate' | 'basic';
  username: string;
  shell: 'cmd' | 'powershell';
  sshGateway?: SshGateway;
  sshGatewayFallbacks: SshGateway[];
}

export function blankWinrmDraft(prefillTarget = '', group = ''): WinrmHostDraft {
  const { host, port, user } = parseHostTarget(prefillTarget);
  return {
    name: '',
    group,
    color: undefined,
    host,
    port: port ?? '',
    https: false,
    tlsVerify: 'verify',
    auth: 'negotiate',
    username: user ?? '',
    shell: 'cmd',
    sshGateway: undefined,
    sshGatewayFallbacks: [],
  };
}

export function winrmDraftFromProfile(saved: SavedHostProfile, duplicate: boolean): WinrmHostDraft {
  const profile = saved.profile;
  if (profile.kind !== 'winrm') throw new Error('saved host is not a WinRM host');
  const https = profile.https === true;
  return {
    name: duplicate ? `${saved.name} copy` : saved.name,
    group: saved.metadata.group ?? '',
    color: saved.metadata.color,
    host: profile.host,
    port: profile.port === (https ? WINRM_PORTS.https : WINRM_PORTS.http) ? '' : String(profile.port),
    https,
    tlsVerify: profile.tlsVerify ?? 'verify',
    auth: profile.auth ?? 'negotiate',
    username: profile.username ?? '',
    shell: profile.shell ?? 'cmd',
    sshGateway: profile.sshGateway,
    sshGatewayFallbacks: profile.sshGatewayFallbacks ?? [],
  };
}

export function winrmDraftPort(draft: WinrmHostDraft): number {
  return draft.port.trim() ? Number(draft.port) : draft.https ? WINRM_PORTS.https : WINRM_PORTS.http;
}

export function winrmDraftProblem(draft: WinrmHostDraft): string | null {
  if (!draft.name.trim()) return 'A name is required — it labels this host in Muxus.';
  if (!draft.host.trim()) return 'Enter a hostname or IP address.';
  if (/\s/.test(draft.host.trim())) return 'The host cannot contain spaces.';
  const port = winrmDraftPort(draft);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Port must be between 1 and 65535.';
  if (draft.auth === 'basic' && !draft.https) {
    return 'Basic authentication sends the password as it is; use it over HTTPS only.';
  }
  return null;
}

export function winrmDraftToInput(draft: WinrmHostDraft, existingId?: string): SavedHostProfileInput {
  const fallbacks = savedGatewayFallbacks(draft.sshGateway, draft.sshGatewayFallbacks);
  return {
    id: existingId,
    name: draft.name.trim(),
    profile: {
      kind: 'winrm',
      host: draft.host.trim(),
      port: winrmDraftPort(draft),
      ...(draft.https ? { https: true } : {}),
      ...(draft.https && draft.tlsVerify === 'skip-verify' ? { tlsVerify: 'skip-verify' as const } : {}),
      ...(draft.auth === 'basic' ? { auth: 'basic' as const } : {}),
      ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
      ...(draft.shell === 'powershell' ? { shell: 'powershell' as const } : {}),
      ...(draft.sshGateway ? { sshGateway: draft.sshGateway } : {}),
      ...(fallbacks ? { sshGatewayFallbacks: fallbacks } : {}),
    },
  };
}

export function winrmDraftMetadataPatch(draft: WinrmHostDraft): OpenSshMetadataPatch {
  return {
    group: draft.group.trim() || null,
    color: draft.color ?? null,
  };
}
