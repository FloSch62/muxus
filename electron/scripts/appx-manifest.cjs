const fs = require('node:fs/promises');

// Store versions require a nonzero major and a zero revision. Offset the
// package major for every release so 0.x is valid and 1.0 remains an upgrade.
// The application's package.json version and other platform builds stay intact.
exports.default = async function appxManifestCreated(manifestPath) {
  const manifest = await fs.readFile(manifestPath, 'utf8');
  const identityVersion = /(<Identity\b[^>]*\bVersion=")(\d+)\.(\d+)\.(\d+)\.(\d+)(")/;
  const match = manifest.match(identityVersion);
  if (!match) throw new Error('AppX manifest is missing its package identity version');
  const [major, minor, patch, revision] = match.slice(2, 6).map(Number);
  if (major >= 65535 || minor > 65535 || patch > 65535 || revision !== 0) {
    throw new Error(`Cannot map ${major}.${minor}.${patch}.${revision} to a Microsoft Store package version`);
  }
  const storeVersion = `${major + 1}.${minor}.${patch}.0`;
  await fs.writeFile(manifestPath, manifest.replace(identityVersion, () => `${match[1]}${storeVersion}${match[6]}`));
};
