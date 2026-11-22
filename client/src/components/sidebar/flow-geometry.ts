import { sheet } from '../../theme.js';

/**
 * Geometry of the sidebar rail and the card that grows out of it. The rail
 * item, the connector and the card each draw part of one outline, so the
 * numbers they share live here rather than in three files. The card is a
 * sheet like every pane, so its own numbers are the theme's.
 */

/** Rail width with icons only, and with its labels pinned open. */
export const RAIL_WIDTH = 48;
export const RAIL_PINNED_WIDTH = 196;
/** A rail item is a square of this size; its row is as tall. */
export const RAIL_ITEM_SIZE = 36;
export const RAIL_ITEM_GAP = 6;
/** Gap between the card and the window chrome around it. */
export const CARD_INSET = sheet.gap;
export const CARD_RADIUS = sheet.radius;
/**
 * Space above the first item and below the last: the card's own inset, so the
 * rail's items start and end level with the card. Joined to the card, the
 * first item's top edge is the card's, and the card gives up its corner there.
 */
export const RAIL_PADDING_TOP = CARD_INSET;
export const RAIL_PADDING_BOTTOM = CARD_INSET;
/** Radius of the concave corners where the connector meets the card. */
export const CONNECTOR_FILLET = sheet.fillet;
/** Distance from the window edge to an item, unpinned and pinned. */
export const RAIL_ITEM_INSET = 7;
export const RAIL_ITEM_INSET_PINNED = 6;

export const RAIL_MOTION = '160ms cubic-bezier(0.4, 0, 0.2, 1)';

/** Top of the item at `index`, from the top of the rail. */
export function railItemTop(index: number): number {
  return RAIL_PADDING_TOP + index * (RAIL_ITEM_SIZE + RAIL_ITEM_GAP);
}
