/**
 * Scale of the whole interface. The terminal keeps its own font zoom
 * (Ctrl/Cmd +/-), so this is a preference rather than a chord: nothing the
 * user presses in a shell can resize the app underneath it.
 */
export const INTERFACE_ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

export const MIN_INTERFACE_ZOOM = 0.5;
export const MAX_INTERFACE_ZOOM = 2;

export function clampInterfaceZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_INTERFACE_ZOOM, Math.max(MIN_INTERFACE_ZOOM, zoom));
}

export function interfaceZoomLabel(zoom: number): string {
  return `${Math.round(clampInterfaceZoom(zoom) * 100)}%`;
}

/**
 * The desktop app scales natively (crisp text, native window controls stay
 * aligned); browsers fall back to CSS zoom on the document element.
 */
export function applyInterfaceZoom(zoom: number): void {
  const scale = clampInterfaceZoom(zoom);
  const desktop = window.muxusDesktop;
  if (desktop?.setZoomFactor) {
    desktop.setZoomFactor(scale);
    return;
  }
  document.documentElement.style.zoom = scale === 1 ? '' : String(scale);
}
