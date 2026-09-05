import { isNewerVersion } from '@muxus/shared';
import type { UpdateCheckResult } from '@muxus/shared';
import { version } from '../package.json';
const UPDATE_MANIFEST_URL = 'https://flosch62.github.io/muxus/latest.json';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
interface UpdateManifest { version?: unknown; releaseName?: unknown; releaseUrl?: unknown; publishedAt?: unknown; }
function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function releaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined;
    if (!url.pathname.startsWith('/FloSch62/muxus/releases/')) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const currentVersion = version;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const url = new URL(UPDATE_MANIFEST_URL);
    if (force) url.searchParams.set('t', String(Date.now()));
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `Muxus/${currentVersion}`,
      },
      signal: controller.signal,
    });
    if (response.status === 404) return { available: false, currentVersion, reason: 'no-release' };
    if (!response.ok) return { available: false, currentVersion, reason: `manifest-${response.status}` };

    const manifest = (await response.json()) as UpdateManifest;
    const version = typeof manifest.version === 'string' ? manifest.version : undefined;
    if (!version) return { available: false, currentVersion, reason: 'missing-version' };

    const latestVersion = normalizeVersion(version);
    if (!isNewerVersion(latestVersion, currentVersion)) return { available: false, currentVersion, latestVersion };

    const downloadUrl = releaseUrl(manifest.releaseUrl);
    if (!downloadUrl) return { available: false, currentVersion, latestVersion, reason: 'missing-release-url' };

    return {
      available: true,
      currentVersion,
      latestVersion,
      releaseName: typeof manifest.releaseName === 'string' && manifest.releaseName ? manifest.releaseName : undefined,
      releaseUrl: downloadUrl,
      publishedAt: typeof manifest.publishedAt === 'string' ? manifest.publishedAt : undefined,
    };
  } catch (err) {
    return {
      available: false,
      currentVersion,
      reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timeout);
  }
}
