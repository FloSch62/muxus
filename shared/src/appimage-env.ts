/**
 * An AppImage puts its own mount first in PATH, XDG_DATA_DIRS and
 * LD_LIBRARY_PATH. Those entries must not reach programs of the host system:
 * a system binary would load the AppImage's libraries, and a space in the
 * mount's name breaks scripts that loop over these lists.
 */
export function withoutAppImagePaths<T extends Record<string, string | undefined>>(env: T): T {
  const mount = env.APPDIR;
  if (!env.APPIMAGE || !mount) return env;
  const cleaned: Record<string, string | undefined> = { ...env };
  for (const name of ['PATH', 'XDG_DATA_DIRS', 'LD_LIBRARY_PATH']) {
    const value = cleaned[name];
    if (value === undefined) continue;
    const kept = value
      .split(':')
      .filter((entry) => entry && entry !== mount && !entry.startsWith(`${mount}/`));
    if (kept.length > 0) cleaned[name] = kept.join(':');
    else delete cleaned[name];
  }
  return cleaned as T;
}
