import type {
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
  SshGateway,
} from '@muxus/shared';
import { savedGatewayFallbacks } from './SshGatewayRouteField.js';

export type ShareKind = 'smb' | 'nfs';

/** Form state for a saved SMB or NFS share; one draft serves both kinds. */
export interface ShareHostDraft {
  name: string;
  group: string;
  color?: string;
  host: string;
  /** SMB: empty is 445. */
  port: string;
  /** SMB share name. */
  share: string;
  /** SMB folder inside the share to open. */
  folder: string;
  username: string;
  /** NFS export path. */
  exportPath: string;
  version: '3' | '4';
  readOnly: boolean;
  sshGateway?: SshGateway;
  sshGatewayFallbacks: SshGateway[];
}

/**
 * `\\server\share\folder`, `smb://server/share` or `server:/export` fill the
 * fields they name; anything else is the host.
 */
export function blankShareDraft(prefillTarget = '', group = ''): ShareHostDraft {
  const draft: ShareHostDraft = {
    name: '',
    group,
    color: undefined,
    host: '',
    port: '',
    share: '',
    folder: '',
    username: '',
    exportPath: '',
    version: '4',
    readOnly: false,
    sshGateway: undefined,
    sshGatewayFallbacks: [],
  };
  return { ...draft, ...parseShareAddress(prefillTarget) };
}

export function parseShareAddress(value: string): Partial<ShareHostDraft> {
  const text = value.trim();
  if (!text) return {};
  const unc = /^(?:\\\\|\/\/|smb:\/\/)(?:([^@/\\]+)@)?([^/\\:]+)(?::(\d+))?(?:[/\\]([^/\\]+))?(?:[/\\](.*))?$/i.exec(text);
  if (unc) {
    return {
      ...(unc[1] ? { username: decodeURIComponent(unc[1]) } : {}),
      host: unc[2]!,
      ...(unc[3] ? { port: unc[3] } : {}),
      ...(unc[4] ? { share: decodeURIComponent(unc[4]) } : {}),
      ...(unc[5] ? { folder: unc[5].replace(/\\/g, '/').replace(/\/+$/, '') } : {}),
    };
  }
  const nfs = /^(?:nfs:\/\/([^/:]+)(\/.*)|([^/:\s]+):(\/.*))$/i.exec(text);
  if (nfs) return { host: nfs[1] ?? nfs[3]!, exportPath: nfs[2] ?? nfs[4]! };
  return { host: text };
}

export function shareDraftFromProfile(saved: SavedHostProfile, duplicate: boolean): ShareHostDraft {
  const profile = saved.profile;
  if (profile.kind !== 'smb' && profile.kind !== 'nfs') throw new Error('saved host is not a share');
  const base = blankShareDraft('', saved.metadata.group ?? '');
  const common = {
    ...base,
    name: duplicate ? `${saved.name} copy` : saved.name,
    color: saved.metadata.color,
    host: profile.host,
    sshGateway: profile.sshGateway,
    sshGatewayFallbacks: profile.sshGatewayFallbacks ?? [],
  };
  return profile.kind === 'smb'
    ? {
        ...common,
        port: profile.port === 445 ? '' : String(profile.port),
        share: profile.share,
        folder: profile.folder ?? '',
        username: profile.username ?? '',
      }
    : {
        ...common,
        exportPath: profile.export,
        version: profile.version ?? '4',
        readOnly: profile.readOnly === true,
      };
}

export function shareDraftProblem(draft: ShareHostDraft, kind: ShareKind): string | null {
  if (!draft.name.trim()) return 'A name is required — it labels this share in Muxus.';
  if (!draft.host.trim()) return 'Enter the server name or IP address.';
  if (/\s/.test(draft.host.trim())) return 'The server name cannot contain spaces.';
  if (kind === 'smb') {
    if (!draft.share.trim()) return 'Enter the share name, e.g. Public.';
    if (/[\\/]/.test(draft.share)) return 'Enter only the share name; put folders inside it under “Folder”.';
    const port = draft.port.trim() ? Number(draft.port) : 445;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Port must be between 1 and 65535.';
    return null;
  }
  if (!draft.exportPath.trim().startsWith('/')) return 'The export path starts with /, e.g. /srv/data.';
  if (draft.sshGateway && draft.version === '3') {
    return 'NFSv3 cannot go through an SSH gateway; choose NFSv4 or remove the gateway.';
  }
  return null;
}

export function shareDraftToInput(draft: ShareHostDraft, kind: ShareKind, existingId?: string): SavedHostProfileInput {
  const fallbacks = savedGatewayFallbacks(draft.sshGateway, draft.sshGatewayFallbacks);
  const route = {
    ...(draft.sshGateway ? { sshGateway: draft.sshGateway } : {}),
    ...(fallbacks ? { sshGatewayFallbacks: fallbacks } : {}),
  };
  const folder = draft.folder.trim().replace(/^[/\\]+|[/\\]+$/g, '');
  return {
    id: existingId,
    name: draft.name.trim(),
    profile:
      kind === 'smb'
        ? {
            kind: 'smb',
            host: draft.host.trim(),
            port: draft.port.trim() ? Number(draft.port) : 445,
            share: draft.share.trim(),
            ...(folder ? { folder } : {}),
            ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
            ...route,
          }
        : {
            kind: 'nfs',
            host: draft.host.trim(),
            export: draft.exportPath.trim(),
            ...(draft.version === '3' ? { version: '3' as const } : {}),
            ...(draft.readOnly ? { readOnly: true } : {}),
            ...route,
          },
  };
}

export function shareDraftMetadataPatch(draft: ShareHostDraft): OpenSshMetadataPatch {
  return {
    group: draft.group.trim() || null,
    color: draft.color ?? null,
  };
}
