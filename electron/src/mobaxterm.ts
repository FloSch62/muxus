import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MobaXtermSessionSource } from '@muxus/shared';

const MAX_MOBAXTERM_FILE_BYTES = 10 * 1024 * 1024;

// Only bookmark values are read. Password and credential registry subkeys are
// deliberately excluded: Muxus prompts for secrets and never persists them.
const READ_BOOKMARKS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$base = Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Mobatek\MobaXterm'
$sections = @(
  Get-ChildItem -LiteralPath $base.PSPath |
    Where-Object { $_.PSChildName -match '^Bookmarks(?:_\d+)?$' } |
    Sort-Object -Property PSChildName
)
if ($sections.Count -eq 0) { exit 2 }
$builder = [System.Text.StringBuilder]::new()
foreach ($section in $sections) {
  $values = Get-ItemProperty -LiteralPath $section.PSPath
  [void]$builder.AppendLine("[$($section.PSChildName)]")
  if ($null -ne $values.SubRep) {
    [void]$builder.AppendLine("SubRep=$($values.SubRep)")
  }
  foreach ($property in $values.PSObject.Properties) {
    if ($property.Name -eq 'SubRep' -or $property.Name -like 'PS*') { continue }
    [void]$builder.AppendLine("$($property.Name)=$($property.Value)")
  }
  [void]$builder.AppendLine()
}
$bytes = [System.Text.Encoding]::UTF8.GetBytes($builder.ToString())
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`;

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8',
        maxBuffer: MAX_MOBAXTERM_FILE_BYTES * 2,
        timeout: 15_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function readRegistryBookmarks(): Promise<MobaXtermSessionSource | undefined> {
  try {
    const encoded = (await runPowerShell(READ_BOOKMARKS_SCRIPT)).trim();
    if (!encoded) return undefined;
    const content = Buffer.from(encoded, 'base64').toString('utf8');
    if (!content.trim() || Buffer.byteLength(content) > MAX_MOBAXTERM_FILE_BYTES) return undefined;
    return { source: 'MobaXterm Windows registry', content };
  } catch {
    return undefined;
  }
}

async function readPortableIni(): Promise<MobaXtermSessionSource | undefined> {
  const appData = process.env.APPDATA;
  if (!appData) return undefined;
  const filename = path.join(appData, 'MobaXterm', 'MobaXterm.ini');
  try {
    const content = await readFile(filename, 'utf8');
    if (!content.trim() || Buffer.byteLength(content) > MAX_MOBAXTERM_FILE_BYTES) return undefined;
    return { source: filename, content };
  } catch {
    return undefined;
  }
}

/** Discover local installer bookmarks first, then the conventional portable INI. */
export async function readLocalMobaXtermSessions(): Promise<MobaXtermSessionSource> {
  if (process.platform !== 'win32') {
    throw new Error('Automatic MobaXterm discovery is only available on Windows.');
  }
  const source = (await readRegistryBookmarks()) ?? (await readPortableIni());
  if (source) return source;
  throw new Error(
    'No local MobaXterm bookmarks were found. Choose MobaXterm.ini or an .mxtsessions export instead.',
  );
}
