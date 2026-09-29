import { build } from 'electron-builder';
import { parseDistributionArgs } from './dist-args.ts';
import { distributionConfig } from './build-config.ts';
import { prepareVcxsrv } from './vcxsrv.mjs';

const options = parseDistributionArgs(process.argv.slice(2));
const platform = options.mac ? 'darwin' : options.win ? 'win32' : options.linux ? 'linux' : process.platform;
const env = options.win?.includes('appx') ? { ...process.env, MUXUS_WINDOWS_TARGET: 'store' } : process.env;
// Windows builds bundle an X server for X11 forwarding (win.extraResources).
if (platform === 'win32') await prepareVcxsrv();
await build({ ...options, config: distributionConfig(env, platform), publish: 'never' });
