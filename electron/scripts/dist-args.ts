import type { CliOptions } from 'electron-builder';

// Preserve the CLI's platform targets and architecture selection, including
// universal macOS and Windows ARM64. All publishing is owned by the workflow.
export function parseDistributionArgs(args: string[]): CliOptions {
  const options: CliOptions = {};
  let platform: 'mac' | 'win' | 'linux' | undefined;
  for (const arg of args) {
    if (arg === '--mac' || arg === '--win' || arg === '--linux') {
      if (platform) throw new Error('Choose one build platform');
      platform = arg.slice(2) as 'mac' | 'win' | 'linux';
      options[platform] = [];
    } else if (arg === '--x64' || arg === '--arm64' || arg === '--universal') {
      options[arg.slice(2) as 'x64' | 'arm64' | 'universal'] = true;
    } else if (platform && !arg.startsWith('-')) {
      options[platform]!.push(arg);
    } else {
      throw new Error(`Unsupported distribution argument: ${arg}`);
    }
  }
  if (options.win?.includes('appx') && options.win.length !== 1) {
    throw new Error('Build the Store package separately from other Windows targets');
  }
  return options;
}
