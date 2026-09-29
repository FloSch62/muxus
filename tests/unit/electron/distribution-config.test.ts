import { describe, expect, it } from 'vitest';
import { distributionConfig } from '../../../electron/scripts/build-config.js';
import { parseDistributionArgs } from '../../../electron/scripts/dist-args.js';

const apple = { MUXUS_RELEASE: '1', CSC_LINK: 'certificate', CSC_KEY_PASSWORD: 'password', APPLE_ID: 'developer', APPLE_TEAM_ID: 'DJY795VD98', APPLE_APP_SPECIFIC_PASSWORD: 'password' };
const store = { MUXUS_WINDOWS_TARGET: 'store', MICROSOFT_STORE_PRODUCT_ID: '9MUXUS000000', MICROSOFT_STORE_IDENTITY_NAME: 'Example.Muxus', MICROSOFT_STORE_PUBLISHER: 'CN=publisher', MICROSOFT_STORE_PUBLISHER_DISPLAY_NAME: 'Example' };

describe('release signing policy', () => {
  it('requires all Apple credentials for releases, with no unsigned fallback', () => {
    for (const key of Object.keys(apple).filter(key => key !== 'MUXUS_RELEASE')) {
      expect(() => distributionConfig({ ...apple, [key]: '' }, 'darwin')).toThrow(key);
    }
    expect(distributionConfig(apple, 'darwin')).toMatchObject({ forceCodeSigning: true, mac: { hardenedRuntime: true, notarize: true, identity: 'Florian Schwarz (DJY795VD98)' } });
    expect(distributionConfig({}, 'darwin').forceCodeSigning).toBeUndefined();
  });

  it('requires a Muxus Store identity and isolates its output and updates', () => {
    for (const key of Object.keys(store).filter(key => key !== 'MUXUS_WINDOWS_TARGET')) {
      expect(() => distributionConfig({ ...store, [key]: '' }, 'win32')).toThrow(key);
    }
    expect(distributionConfig({ ...store, WINDOWS_SIGNING: 'certificate' }, 'win32')).toMatchObject({
      publish: null,
      directories: { output: 'release-store' },
      win: { target: 'appx' },
      extraMetadata: { muxusUpdateMode: 'store', muxusStoreProductId: store.MICROSOFT_STORE_PRODUCT_ID },
      appx: { identityName: 'Example.Muxus', publisher: 'CN=publisher' },
    });
  });

  it('rejects incomplete or unknown Windows signing modes', () => {
    expect(() => distributionConfig({ WINDOWS_SIGNING: 'certificate', WINDOWS_PUBLISHER_NAME: 'Publisher' }, 'win32')).toThrow('WIN_CSC_LINK');
    expect(() => distributionConfig({ WINDOWS_SIGNING: 'azure', WINDOWS_PUBLISHER_NAME: 'Publisher' }, 'win32')).toThrow('AZURE_SIGNING_ENDPOINT');
    expect(() => distributionConfig({ WINDOWS_SIGNING: 'invalid', WINDOWS_PUBLISHER_NAME: 'Publisher' }, 'win32')).toThrow('Unknown WINDOWS_SIGNING');
    expect(distributionConfig({ WINDOWS_SIGNING: 'certificate', WINDOWS_PUBLISHER_NAME: 'Publisher', WIN_CSC_LINK: 'certificate' }, 'win32').forceCodeSigning).toBe(true);
  });
});

describe('distribution target selection', () => {
  it.each([
    [['--mac', 'dmg', '--universal'], { mac: ['dmg'], universal: true }],
    [['--win', 'nsis', '--arm64'], { win: ['nsis'], arm64: true }],
    [['--win', 'appx', '--x64'], { win: ['appx'], x64: true }],
    [['--linux', 'AppImage', 'deb', '--x64'], { linux: ['AppImage', 'deb'], x64: true }],
  ])('preserves %j', (args, expected) => {
    expect(parseDistributionArgs(args)).toEqual(expected);
  });

  it('rejects mixed Store/NSIS packages and unknown flags', () => {
    expect(() => parseDistributionArgs(['--win', 'appx', 'nsis'])).toThrow('separately');
    expect(() => parseDistributionArgs(['--publish', 'always'])).toThrow('Unsupported');
  });
});
