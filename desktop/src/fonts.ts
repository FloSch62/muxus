import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let fonts: Promise<string[] | undefined> | undefined;

/** Query family names through the OS; native webviews do not expose queryLocalFonts. */
export function listLocalFontFamilies(): Promise<string[] | undefined> {
  return fonts ??= (async () => {
    try {
      const [command, args] = process.platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name']] as const
        : process.platform === 'darwin'
          ? ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies).join("\\n")']] as const
          : ['fc-list', ['--format=%{family}\\n']] as const;
      const { stdout } = await exec(command, [...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return [...new Set(stdout.split(/[\r\n,]/).map((name) => name.trim()).filter((name) => name && name.length <= 200))].sort((a, b) => a.localeCompare(b));
    } catch { fonts = undefined; return undefined; }
  })();
}
