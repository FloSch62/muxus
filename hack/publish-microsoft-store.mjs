import { execFileSync } from 'node:child_process';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function runStore(args, capture = false) {
  try {
    return execFileSync('msstore', args, {
      encoding: 'utf8',
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    throw new Error(`Microsoft Store command failed: ${args[0]}. See the CLI output above.`);
  }
}

function versionParts(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Microsoft Store returned an invalid package version.');
  }
  return version.split('.').map(Number);
}

function isAtLeast(version, target) {
  const actual = versionParts(version);
  for (let i = 0; i < target.length; i += 1) {
    if (actual[i] !== target[i]) return actual[i] > target[i];
  }
  return true;
}

// Use the already-built artifact. The CLI's Electron publisher supports AppX,
// but runs npm install while detecting a project. Stage only package metadata
// here so it cannot install dependencies or run scripts from our pnpm workspace.
export async function publishStore(directory, version, run = runStore, env = process.env) {
  const productId = env.MICROSOFT_STORE_PRODUCT_ID?.trim();
  const identityName = env.MICROSOFT_STORE_IDENTITY_NAME?.trim();
  if (!productId || !/^[A-Z0-9]{12}$/.test(productId) || !identityName) {
    throw new Error('Set MICROSOFT_STORE_PRODUCT_ID and MICROSOFT_STORE_IDENTITY_NAME for the reserved Muxus product.');
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Only stable release versions can be submitted to Microsoft Store.');
  }
  const [major, minor, patch] = version.split('.').map(Number);
  if (major >= 65535 || minor > 65535 || patch > 65535) {
    throw new Error('Release version cannot be mapped to a Microsoft Store package version.');
  }
  const inputDirectory = path.resolve(directory);
  const expectedFile = `muxus-${version}-win-x64.appx`;
  const packages = (await readdir(inputDirectory)).filter((file) => file.endsWith('.appx'));
  if (packages.length !== 1 || packages[0] !== expectedFile) {
    throw new Error(`Expected exactly one Store package: ${expectedFile}`);
  }

  const app = JSON.parse(run(['apps', 'get', productId], true));
  if (app.Id !== productId || app.PackageIdentityName !== identityName) {
    throw new Error('Microsoft Store returned an unexpected product identity.');
  }
  if (!app.LastPublishedApplicationSubmission?.Id) {
    return 'Store upload skipped: publish the first release manually in Partner Center using the muxus-windows-store artifact. Later releases will submit automatically.';
  }
  if (app.PendingApplicationSubmission?.Id) {
    throw new Error('Muxus has a pending Store submission. Finish it in Partner Center, then rerun this job. The existing submission was left intact.');
  }

  const submission = JSON.parse(run(['submission', 'get', productId], true));
  if (submission.Id !== app.LastPublishedApplicationSubmission.Id) {
    throw new Error('The Store submission changed during the check. Rerun this job after resolving it in Partner Center.');
  }
  if (!Array.isArray(submission.ApplicationPackages) || submission.ApplicationPackages.length === 0) {
    throw new Error('The published Store submission has no package versions to compare.');
  }
  const target = [major + 1, minor, patch, 0];
  if (submission.ApplicationPackages.some((pkg) => isAtLeast(pkg.Version, target))) {
    return `Store upload skipped: package version ${target.join('.')} or newer is already published.`;
  }

  await writeFile(path.join(inputDirectory, 'package.json'), JSON.stringify({
    name: 'muxus-store-submission',
    private: true,
    version,
  }, null, 2));

  run(['publish', inputDirectory, '--inputDirectory', inputDirectory, '--appId', productId, '--noCommit', '--uploadTimeout', '600']);
  // Commit separately so the runner does not wait through Store certification.
  run(['submission', 'publish', productId]);
  return `Submitted Muxus ${version} (Store package ${target.join('.')}) for certification. Publication follows the Store submission's publishing schedule.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { version } = JSON.parse(await readFile(new URL('../electron/package.json', import.meta.url), 'utf8'));
    const message = await publishStore(process.argv[2] ?? 'store-package', version);
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
