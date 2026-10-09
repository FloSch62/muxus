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

/** Where a window was last left: its restored (not maximized) bounds. */
export interface WindowPlacement extends Rectangle {
  maximized?: boolean;
}

/** A stored placement, or undefined when the file holds anything else. */
export function parseWindowPlacement(value: unknown): WindowPlacement | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const placement = value as Record<string, unknown>;
  const { x, y, width, height, maximized } = placement;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { x, y, width, height, ...(maximized === true ? { maximized: true } : {}) };
}

/**
 * Bounds for a window that remembers its placement. Displays can be unplugged
 * or rearranged between runs, so saved bounds move onto the display they
 * overlap most and shrink to fit it. Without saved bounds, or when they no
 * longer touch any display, the window opens centered over `owner`. Only the
 * size comes back when neither is available, and the system places it.
 */
export function windowBounds(
  saved: Rectangle | undefined,
  owner: Rectangle | undefined,
  workAreas: readonly Rectangle[],
  defaultSize: Size,
): Rectangle | Size {
  if (saved) {
    const area = mostOverlapping(saved, workAreas);
    if (area) return fitInside(saved, area);
  }
  const size = saved ? { width: saved.width, height: saved.height } : defaultSize;
  if (!owner) return size;
  const area = mostOverlapping(owner, workAreas);
  const centered = {
    x: Math.round(owner.x + (owner.width - size.width) / 2),
    y: Math.round(owner.y + (owner.height - size.height) / 2),
    ...size,
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
