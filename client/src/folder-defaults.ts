import type { FolderAuthSettings, FolderSettingsRecord } from '@muxus/shared';

/** Materialize the non-secret defaults the saved profile inherits in Muxus. */
export function savedProfileFolderDefaults(
  group: string | undefined,
  folders: readonly FolderSettingsRecord[],
): { auth: FolderAuthSettings; hasPassword: boolean } {
  const parts = (group ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { auth: {}, hasPassword: false };

  const byPath = new Map(
    folders.map((folder) => [folder.path.toLocaleLowerCase(), folder]),
  );
  const auth: FolderAuthSettings = {};
  let hasPassword = false;
  for (let length = parts.length; length > 0; length--) {
    const folder = byPath.get(parts.slice(0, length).join('/').toLocaleLowerCase());
    if (!folder) continue;
    hasPassword ||= folder.hasPassword;
    if (auth.user === undefined) auth.user = folder.auth.user;
    if (auth.port === undefined) auth.port = folder.auth.port;
    if (auth.identityFiles === undefined) auth.identityFiles = folder.auth.identityFiles;
    if (auth.identitiesOnly === undefined) auth.identitiesOnly = folder.auth.identitiesOnly;
    if (auth.identityAgent === undefined) auth.identityAgent = folder.auth.identityAgent;
    if (auth.forwardAgent === undefined) auth.forwardAgent = folder.auth.forwardAgent;
  }
  return { auth, hasPassword };
}
