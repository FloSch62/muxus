export const DEFAULT_ENVIRONMENTS_PANEL_WIDTH = 460;
export const MIN_ENVIRONMENTS_PANEL_WIDTH = 340;
/** Room the panel leaves for the host sidebar beside it and a usable workspace. */
const RESERVED_WIDTH = 560;

/**
 * The panel shares its row with the sidebar and the panes: it may take most of
 * the window, but never squeeze the panes below their practical minimum.
 */
export function maxEnvironmentsPanelWidth(containerWidth: number): number {
  return Math.max(
    MIN_ENVIRONMENTS_PANEL_WIDTH,
    Math.floor(Math.min(containerWidth * 0.75, containerWidth - RESERVED_WIDTH)),
  );
}

export function clampEnvironmentsPanelWidth(width: number, containerWidth: number): number {
  return Math.max(
    MIN_ENVIRONMENTS_PANEL_WIDTH,
    Math.min(maxEnvironmentsPanelWidth(containerWidth), Math.round(width)),
  );
}
