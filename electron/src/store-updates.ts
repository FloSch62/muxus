import type { UpdateCheckResult } from '@muxus/shared';

export interface DistributionMetadata {
  muxusUpdateMode?: string;
  muxusStoreProductId?: string;
}

export async function checkStoreUpdate(
  metadata: DistributionMetadata,
  windowsStore: boolean,
  currentVersion: string,
  force: boolean,
  openExternal: (url: string) => Promise<unknown>,
): Promise<UpdateCheckResult | undefined> {
  if (!windowsStore && metadata.muxusUpdateMode !== 'store') return undefined;
  if (force) {
    const productId = metadata.muxusStoreProductId;
    const url = productId && /^[A-Z0-9]{12}$/.test(productId)
      ? `ms-windows-store://pdp/?ProductId=${productId}`
      : 'ms-windows-store://downloadsandupdates';
    try {
      await openExternal(url);
    } catch {
      return { available: false, currentVersion, reason: 'store-open-failed' };
    }
  }
  return { available: false, currentVersion, reason: 'store' };
}
