import { describe, expect, it } from 'vitest';
import type { AppInfo } from '@muxus/shared';
import { installationFacts, releaseNotesUrl } from '../../../client/src/app-facts.js';

const appInfo: AppInfo = {
  name: 'Muxus',
  version: '0.8.1',
  platform: 'linux',
  homeDir: '/home/someone',
  defaultShell: '/bin/zsh',
  sshAlgorithms: {},
};

describe('releaseNotesUrl', () => {
  it('links the release notes of the running minor version', () => {
    expect(releaseNotesUrl('0.8.1')).toBe('https://flosch62.github.io/muxus/release-notes/0.8/');
    expect(releaseNotesUrl('0.10.0-beta.1')).toBe(
      'https://flosch62.github.io/muxus/release-notes/0.10/',
    );
  });

  it('falls back to the release notes index without a version', () => {
    expect(releaseNotesUrl(undefined)).toBe('https://flosch62.github.io/muxus/release-notes/');
    expect(releaseNotesUrl('dev')).toBe('https://flosch62.github.io/muxus/release-notes/');
  });
});

describe('installationFacts', () => {
  it('names Electron and Chromium in the desktop app, and no server address', () => {
    const facts = Object.fromEntries(
      installationFacts(appInfo, {
        desktopPlatform: 'darwin',
        userAgent:
          'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Muxus/0.8.1 Chrome/140.0.7339.41 Electron/44.3.0 Safari/537.36',
        host: '127.0.0.1:41234',
      }),
    );
    expect(facts).toEqual({
      Version: '0.8.1',
      'Runs as': 'Desktop app',
      Platform: 'macOS',
      Electron: '44.3.0',
      Chromium: '140.0.7339.41',
    });
  });

  it('names the browser and the server in the web app', () => {
    const facts = Object.fromEntries(
      installationFacts(appInfo, {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        host: 'jumpbox:3000',
      }),
    );
    expect(facts).toMatchObject({
      'Runs as': 'Web app in your browser',
      Platform: 'Windows',
      Browser: 'Chrome 148.0.0.0',
      Server: 'jumpbox:3000',
      'Server platform': 'Linux',
    });
    expect(facts.Electron).toBeUndefined();
  });

  it('never includes the home directory or the default shell', () => {
    const text = installationFacts(appInfo, { userAgent: 'curl/8', host: 'localhost:3000' })
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    expect(text).not.toContain('/home/someone');
    expect(text).not.toContain('zsh');
    expect(text).toContain('Platform: Unknown');
  });

  it('reports an unknown version before the app info has loaded', () => {
    const facts = Object.fromEntries(
      installationFacts(undefined, { userAgent: 'Firefox/140.0', host: 'localhost:3000' }),
    );
    expect(facts.Version).toBe('unknown');
    expect(facts['Server platform']).toBeUndefined();
  });
});
