export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 520;
export const MIN_MAIN_WORKSPACE_WIDTH = 320;

export function maxSidebarWidth(containerWidth: number): number {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.floor(
      Math.min(
        MAX_SIDEBAR_WIDTH,
        containerWidth * 0.45,
        containerWidth - MIN_MAIN_WORKSPACE_WIDTH,
      ),
    ),
  );
}

export function clampSidebarWidth(width: number, containerWidth: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxSidebarWidth(containerWidth), Math.round(width)));
}
