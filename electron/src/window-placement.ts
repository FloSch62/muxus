export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** How a window was last left: its restored (not maximized) size. */
export interface WindowPlacement extends Size {
  maximized?: boolean;
}

/** A stored placement, or undefined when the file holds anything else. */
export function parseWindowPlacement(value: unknown): WindowPlacement | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const placement = value as Record<string, unknown>;
  const { width, height, maximized } = placement;
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height, ...(maximized === true ? { maximized: true } : {}) };
}

/**
 * Bounds for a window that opens centered over `owner`, kept inside the
 * display `owner` overlaps most and shrunk to fit it. Only the size comes back
 * without an owner, and the system places it.
 */
export function windowBounds(
  size: Size,
  owner: Rectangle | undefined,
  workAreas: readonly Rectangle[],
): Rectangle | Size {
  const { width, height } = size;
  if (!owner) return { width, height };
  const area = mostOverlapping(owner, workAreas);
  const centered = {
    x: Math.round(owner.x + (owner.width - width) / 2),
    y: Math.round(owner.y + (owner.height - height) / 2),
    width,
    height,
  };
  return area ? fitInside(centered, area) : centered;
}

function mostOverlapping(
  bounds: Rectangle,
  workAreas: readonly Rectangle[],
): Rectangle | undefined {
  let best: Rectangle | undefined;
  let bestOverlap = 0;
  for (const area of workAreas) {
    const overlap = overlapArea(bounds, area);
    if (overlap > bestOverlap) {
      best = area;
      bestOverlap = overlap;
    }
  }
  return best;
}

function overlapArea(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function fitInside(bounds: Rectangle, area: Rectangle): Rectangle {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: clamp(bounds.x, area.x, area.x + area.width - width),
    y: clamp(bounds.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
