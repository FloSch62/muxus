import type {
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfileInput,
  SshGateway,
} from '@muxus/shared';

/** Form state for a saved web page. */
export interface WebHostDraft {
  name: string;
  url: string;
  group: string;
  color?: string;
  /** SSH host whose SOCKS5 proxy carries the page; undefined connects directly. */
  sshGateway?: SshGateway;
}

export function blankWebDraft(prefillTarget = '', group = '', sshGateway?: SshGateway): WebHostDraft {
  const target = prefillTarget.trim();
  return {
    name: '',
    url: target ? normalizeWebUrl(target) : '',
    group,
    color: undefined,
    sshGateway,
  };
}

export function webDraftFromProfile(saved: SavedHostProfile, duplicate: boolean): WebHostDraft {
  const profile = saved.profile;
  if (profile.kind !== 'web') throw new Error('saved host is not a web page');
  return {
    name: duplicate ? `${saved.name} copy` : saved.name,
    url: profile.url,
    group: saved.metadata.group ?? '',
    color: saved.metadata.color,
    sshGateway: profile.sshGateway,
  };
}

/** `intranet:8080/app` → `http://intranet:8080/app`; an explicit scheme is kept. */
export function normalizeWebUrl(value: string): string {
  const text = value.trim();
  if (!text || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `http://${text}`;
}

export function webDraftProblem(draft: WebHostDraft): string | null {
  if (!draft.name.trim()) return 'A name is required — it labels this page in Muxus.';
  const url = normalizeWebUrl(draft.url);
  if (!url) return 'Enter the address of the page.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'This is not a valid address.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http:// and https:// addresses can be opened.';
  }
  if (!parsed.hostname) return 'The address needs a host name.';
  return null;
}

export function webDraftToInput(draft: WebHostDraft, existingId?: string): SavedHostProfileInput {
  return {
    id: existingId,
    name: draft.name.trim(),
    profile: {
      kind: 'web',
      url: normalizeWebUrl(draft.url),
      ...(draft.sshGateway ? { sshGateway: draft.sshGateway } : {}),
    },
  };
}

export function webDraftMetadataPatch(draft: WebHostDraft): OpenSshMetadataPatch {
  return {
    group: draft.group.trim() || null,
    color: draft.color ?? null,
  };
}
