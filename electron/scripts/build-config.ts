import type { Configuration } from 'electron-builder';

/** Signing is selected explicitly; configured signing must never fall back to unsigned. */
export function distributionConfig(env: NodeJS.ProcessEnv, platform: string): Configuration {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}; see docs/community/releasing.md`);
    return value;
  };
  const config: { -readonly [Key in keyof Configuration]: Configuration[Key] } = { extends: './electron-builder.yml' };
  if (platform === 'darwin' && env.MUXUS_RELEASE === '1') {
    required('CSC_LINK'); required('CSC_KEY_PASSWORD');
    required('APPLE_ID'); required('APPLE_APP_SPECIFIC_PASSWORD'); required('APPLE_TEAM_ID');
    config.forceCodeSigning = true;
    config.mac = { identity: 'Florian Schwarz (DJY795VD98)', hardenedRuntime: true, notarize: true };
  }
  if (platform !== 'win32') return config;
  if (env.MUXUS_WINDOWS_TARGET === 'store') {
    config.directories = { output: 'release-store' };
    const productId = required('MICROSOFT_STORE_PRODUCT_ID');
    if (!/^[A-Z0-9]{12}$/.test(productId)) throw new Error('Invalid MICROSOFT_STORE_PRODUCT_ID');
    config.extraMetadata = { muxusUpdateMode: 'store', muxusStoreProductId: productId };
    config.publish = null;
    // Builder 26 emits AppX, accepted by the Store alongside MSIX. The Store
    // signs this package after certification; its identity comes from Partner Center.
    // A scalar replaces the base NSIS target; builder concatenates target arrays.
    config.win = { target: 'appx', signtoolOptions: { sign: async () => {} } };
    config.appx = {
      identityName: required('MICROSOFT_STORE_IDENTITY_NAME'),
      publisher: required('MICROSOFT_STORE_PUBLISHER'),
      publisherDisplayName: required('MICROSOFT_STORE_PUBLISHER_DISPLAY_NAME'),
      applicationId: 'Muxus',
    };
    return config;
  }
  const signing = env.WINDOWS_SIGNING || 'unsigned';
  if (signing === 'unsigned') {
    config.win = { signtoolOptions: { sign: async () => {} } };
    return config;
  }
  config.forceCodeSigning = true;
  const publisherName = required('WINDOWS_PUBLISHER_NAME');
  if (signing === 'certificate') {
    if (!env.WIN_CSC_LINK && !env.WINDOWS_CERTIFICATE_SHA1) throw new Error('Set WIN_CSC_LINK or WINDOWS_CERTIFICATE_SHA1');
    config.win = { signtoolOptions: { publisherName, signingHashAlgorithms: ['sha256'], certificateSha1: env.WINDOWS_CERTIFICATE_SHA1 } };
  } else if (signing === 'azure') {
    config.win = { azureSignOptions: {
      publisherName, endpoint: required('AZURE_SIGNING_ENDPOINT'),
      codeSigningAccountName: required('AZURE_SIGNING_ACCOUNT'), certificateProfileName: required('AZURE_SIGNING_PROFILE'),
    } };
  } else if (signing === 'custom') {
    config.win = { signtoolOptions: { publisherName, signingHashAlgorithms: ['sha256'], sign: required('WINDOWS_SIGN_SCRIPT') } };
  } else {
    throw new Error(`Unknown WINDOWS_SIGNING mode: ${signing}`);
  }
  return config;
}
