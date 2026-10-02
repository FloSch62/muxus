import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'electron-builder';
import { parseDistributionArgs } from './dist-args.ts';
import { distributionConfig } from './build-config.ts';
import { prepareVcxsrv } from './vcxsrv.mjs';

const options = parseDistributionArgs(process.argv.slice(2));
const platform = options.mac ? 'darwin' : options.win ? 'win32' : options.linux ? 'linux' : process.platform;
const store = options.win?.includes('appx') === true;
const env = store ? { ...process.env, MUXUS_WINDOWS_TARGET: 'store' } : process.env;
// Windows builds bundle an X server for X11 forwarding (win.extraResources).
if (platform === 'win32') await prepareVcxsrv();
// Store builds bundle the native Microsoft Store update helper.
if (store) {
  if (process.platform !== 'win32') throw new Error('Store packaging requires Windows with Visual Studio C++ Build Tools.');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./build-store-updater.ps1', import.meta.url))], { stdio: 'inherit' });
}
await build({ ...options, config: distributionConfig(env, platform), publish: 'never' });
