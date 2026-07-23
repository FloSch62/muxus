const fs = require('node:fs/promises');
const path = require('node:path');

// Wrap the Linux executable in a launcher that forces X11 (XWayland):
// under native Wayland GNOME matches windows to .desktop files by app_id,
// which Electron doesn't set to ours — the dash then shows no icon. Under
// X11 the WM_CLASS/StartupWMClass match works. AppImages additionally need
// --no-sandbox: their chrome-sandbox can't be SUID inside the squashfs and
// Ubuntu 24.04's AppArmor blocks the user-namespace fallback (the deb keeps
// the full sandbox via its AppArmor profile).
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') {
    return;
  }

  const executableName = context.packager.executableName;
  const executablePath = path.join(context.appOutDir, executableName);
  const realExecutablePath = `${executablePath}.bin`;

  try {
    await fs.access(realExecutablePath);
    return; // already wrapped
  } catch {
    /* not wrapped yet */
  }

  await fs.rename(executablePath, realExecutablePath);
  await fs.writeFile(
    executablePath,
    [
      '#!/bin/sh',
      '# Resolve update-alternatives links such as /usr/bin/muxus.',
      'APP_DIR="$(dirname -- "$(readlink -f -- "$0")")"',
      'if [ -n "$APPIMAGE" ]; then',
      `  exec "$APP_DIR/${executableName}.bin" --ozone-platform=x11 --no-sandbox "$@"`,
      'fi',
      `exec "$APP_DIR/${executableName}.bin" --ozone-platform=x11 "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
};
