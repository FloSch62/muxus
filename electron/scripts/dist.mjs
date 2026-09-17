import { build } from 'electron-builder';
import { parseDistributionArgs } from './dist-args.ts';
import { distributionConfig } from './build-config.ts';

const options = parseDistributionArgs(process.argv.slice(2));
const platform = options.mac ? 'darwin' : options.win ? 'win32' : options.linux ? 'linux' : process.platform;
const env = options.win?.includes('appx') ? { ...process.env, MUXUS_WINDOWS_TARGET: 'store' } : process.env;
await build({ ...options, config: distributionConfig(env, platform), publish: 'never' });
