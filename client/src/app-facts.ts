import type { AppInfo } from '@muxus/shared';

export const DOCS_URL = 'https://flosch62.github.io/muxus/';

/** The docs page with this version's release notes: `0.8.1` → `/release-notes/0.8/`. */
export function releaseNotesUrl(version?: string): string {
  const minor = /^(\d+\.\d+)/.exec(version ?? '')?.[1];
  return minor ? `${DOCS_URL}release-notes/${minor}/` : `${DOCS_URL}release-notes/`;
}

export function platformLabel(platform?: string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform ?? '';
  }
}

/** What the window knows about where it runs; passed in so the facts stay testable. */
export interface FactsEnvironment {
  /** The desktop bridge's platform; absent in a regular browser. */
  desktopPlatform?: string;
  userAgent: string;
  /** The browser's own platform hint (`navigator.userAgentData.platform`). */
  platformHint?: string;
  /** The page's host, which is the server address in the web app. */
  host: string;
}

export function currentFactsEnvironment(): FactsEnvironment {
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  return {
    desktopPlatform: window.muxusDesktop?.platform,
    userAgent: navigator.userAgent,
    platformHint: hinted || undefined,
    host: window.location.host,
  };
}

/** The OS the window runs on, from the desktop bridge or the browser. */
function windowPlatform(env: FactsEnvironment): string {
  if (env.desktopPlatform) return platformLabel(env.desktopPlatform);
  if (env.platformHint) return env.platformHint;
  const ua = env.userAgent;
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

/** The browser engine as the user agent names it: Electron and Chromium in the desktop app, the browser otherwise. */
function engineFacts(ua: string): Array<[string, string]> {
  const electron = /Electron\/([\d.]+)/.exec(ua)?.[1];
  const chrome = /Chrome\/([\d.]+)/.exec(ua)?.[1];
  if (electron) {
    return [['Electron', electron], ...(chrome ? [['Chromium', chrome] as [string, string]] : [])];
  }
  const edge = /Edg\/([\d.]+)/.exec(ua)?.[1];
  const firefox = /Firefox\/([\d.]+)/.exec(ua)?.[1];
  const safari = !chrome && /Version\/([\d.]+).*Safari/.exec(ua)?.[1];
  const browser = edge
    ? `Edge ${edge}`
    : chrome
      ? `Chrome ${chrome}`
      : firefox
        ? `Firefox ${firefox}`
        : safari
          ? `Safari ${safari}`
          : undefined;
  return browser ? [['Browser', browser]] : [];
}

/**
 * Facts about this installation that are known for certain, for a bug report.
 * No secrets and nothing personal: never the API token, the home directory or
 * a saved host, and the server address only in the web app, where it is the
 * page's own host.
 */
export function installationFacts(
  appInfo: AppInfo | undefined,
  env: FactsEnvironment,
): Array<[string, string]> {
  const desktop = !!env.desktopPlatform;
  return [
    ['Version', appInfo?.version ?? 'unknown'],
    ['Runs as', desktop ? 'Desktop app' : 'Web app in your browser'],
    ['Platform', windowPlatform(env)],
    ...engineFacts(env.userAgent),
    ...(desktop
      ? []
      : ([
          ['Server', env.host],
          ...(appInfo ? [['Server platform', platformLabel(appInfo.platform)]] : []),
        ] as Array<[string, string]>)),
  ];
}
