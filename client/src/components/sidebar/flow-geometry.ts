/**
 * Geometry of the sidebar rail and the card that grows out of it. The rail
 * item, the connector and the card each draw part of one outline, so the
 * numbers they share live here rather than in three files.
 */

/** Rail width with icons only, and with its labels pinned open. */
export const RAIL_WIDTH = 48;
export const RAIL_PINNED_WIDTH = 196;
/** A rail item is a square of this size; its row is as tall. */
export const RAIL_ITEM_SIZE = 36;
export const RAIL_ITEM_GAP = 6;
/**
 * Space above the first item. The card's rounded corner and the connector's
 * fillet above the first item each need their own radius of straight edge.
 */
export const RAIL_PADDING_TOP = 26;
export const RAIL_PADDING_BOTTOM = 8;
/** Gap between the card and the window chrome around it. */
export const CARD_INSET = 6;
export const CARD_RADIUS = 10;
/** Radius of the concave corners where the connector meets the card. */
export const CONNECTOR_FILLET = 10;
/** Distance from the window edge to an item, unpinned and pinned. */
export const RAIL_ITEM_INSET = 7;
export const RAIL_ITEM_INSET_PINNED = 6;

export const RAIL_MOTION = '160ms cubic-bezier(0.4, 0, 0.2, 1)';

/** Top of the item at `index`, from the top of the rail. */
export function railItemTop(index: number): number {
  return RAIL_PADDING_TOP + index * (RAIL_ITEM_SIZE + RAIL_ITEM_GAP);
}
