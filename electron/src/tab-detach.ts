export interface ScreenPoint {
  x: number;
  y: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether the native cursor is currently over any Muxus window. */
export function pointInsideAnyWindow(
  point: ScreenPoint,
  windows: readonly WindowBounds[],
): boolean {
  return windows.some(
    (bounds) =>
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + bounds.height,
  );
}
