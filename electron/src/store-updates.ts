import type { UpdateCheckResult } from '@muxus/shared';

export interface DistributionMetadata {
  muxusUpdateMode?: string;
  muxusStoreProductId?: string;
}

export function isStoreDistribution(metadata: DistributionMetadata, windowsStore: boolean): boolean {
  return windowsStore || metadata.muxusUpdateMode === 'store';
}

/** The Muxus Store page, or the Store's update list when the product is unknown. */
export function storePageUrl(metadata: DistributionMetadata): string {
  const productId = metadata.muxusStoreProductId;
  return productId && /^[A-Z0-9]{12}$/.test(productId)
    ? `ms-windows-store://pdp/?ProductId=${productId}`
    : 'ms-windows-store://downloadsandupdates';
}

export async function checkStoreUpdate(
  metadata: DistributionMetadata,
  windowsStore: boolean,
  currentVersion: string,
  force: boolean,
  openExternal: (url: string) => Promise<unknown>,
): Promise<UpdateCheckResult | undefined> {
  if (!isStoreDistribution(metadata, windowsStore)) return undefined;
  if (force) {
    try {
      await openExternal(storePageUrl(metadata));
    } catch {
      return { available: false, currentVersion, reason: 'store-open-failed' };
    }
  }
  return { available: false, currentVersion, reason: 'store' };
}
