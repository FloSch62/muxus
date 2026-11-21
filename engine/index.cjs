'use strict';

// Loads the engine built for this computer. Each file is named in full so a bundler can see
// which ones exist; the packaged app ships them beside its bundle.
function load() {
  switch (`${process.platform}-${process.arch}`) {
    case 'linux-x64':
      return require('./muxus-ssh-engine.linux-x64-gnu.node');
    case 'linux-arm64':
      return require('./muxus-ssh-engine.linux-arm64-gnu.node');
    case 'darwin-x64':
      return require('./muxus-ssh-engine.darwin-x64.node');
    case 'darwin-arm64':
      return require('./muxus-ssh-engine.darwin-arm64.node');
    case 'win32-x64':
      return require('./muxus-ssh-engine.win32-x64-msvc.node');
    case 'win32-arm64':
      return require('./muxus-ssh-engine.win32-arm64-msvc.node');
    default:
      throw new Error(`The Muxus SSH engine has no build for ${process.platform} on ${process.arch}.`);
  }
}

try {
  module.exports = load();
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    throw new Error(
      'The Muxus SSH engine has not been built. Run "pnpm --filter @muxus/ssh-engine build" (it needs a Rust toolchain).',
      { cause: err },
    );
  }
  throw err;
}
