import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const patchManifest = require('../../../electron/scripts/appx-manifest.cjs').default as (file: string) => Promise<void>;
let directory: string;
let manifestPath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'muxus-store-manifest-'));
  manifestPath = path.join(directory, 'AppxManifest.xml');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('Microsoft Store package versions', () => {
  it.each([
    ['0.9.0.0', '1.9.0.0'],
    ['0.10.0.0', '1.10.0.0'],
    ['1.0.0.0', '2.0.0.0'],
    ['65534.65535.65535.0', '65535.65535.65535.0'],
  ])('maps %s to %s without changing other manifest fields', async (version, expected) => {
    const manifest = `<Package>
  <Identity Name="Example.Muxus" Publisher="CN=test"
    ProcessorArchitecture="x64" Version="${version}" />
  <Dependencies><PackageDependency Name="Framework" MinVersion="1.0.0.0" /></Dependencies>
</Package>`;
    await writeFile(manifestPath, manifest);
    await patchManifest(manifestPath);
    expect(await readFile(manifestPath, 'utf8')).toBe(manifest.replace(`Version="${version}"`, `Version="${expected}"`));
  });

  it.each(['65535.0.0.0', '1.65536.0.0', '1.0.65536.0', '1.0.0.1'])('rejects an unrepresentable version %s', async (version) => {
    const manifest = `<Package><Identity Version="${version}" /></Package>`;
    await writeFile(manifestPath, manifest);
    await expect(patchManifest(manifestPath)).rejects.toThrow('Cannot map');
    expect(await readFile(manifestPath, 'utf8')).toBe(manifest);
  });

  it('fails when there is no identity version instead of emitting an invalid package', async () => {
    await writeFile(manifestPath, '<Package />');
    await expect(patchManifest(manifestPath)).rejects.toThrow('missing its package identity version');
  });
});
