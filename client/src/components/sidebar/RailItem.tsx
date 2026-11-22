import { memo, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Tooltip from '@mui/material/Tooltip';
import { RAIL_ITEM_INSET, RAIL_ITEM_INSET_PINNED, RAIL_ITEM_SIZE, RAIL_MOTION } from './flow-geometry.js';

/** What a hovered or keyboard-focused item looks like while the rail is not pinned. */
const REVEALED = {
  '--rail-item-max-width': '260px',
  '--rail-label-opacity': 1,
  '--rail-label-offset': '0px',
  '--rail-surface-opacity': 1,
  zIndex: 2,
} as const;

/**
 * How the carved label ends toward the item above or below it.
 * - `shoulder`: the rail's edge runs on past the item, and bends out around the label.
 * - `flat`: the item on that side is joined to the panel. Its edge is the
 *   label's edge too: one line, and the join stays whole.
 * - `open`: the item stands at the end of the sheet beside the rail. There is
 *   no edge beyond it to bend, so the sheet's corner steps aside instead.
 */
export type RailCarveEnd = 'shoulder' | 'flat' | 'open';

export interface RailItemProps {
  /** What the item is called, with anything worth adding, such as a count. */
  label: string;
  /** The name alone, for the pinned rail, whose labels share one narrow column. */
  shortLabel?: string;
  icon: ReactNode;
  /** Labels stay beside the icons. Unpinned, a label is carved out of the rail on hover. */
  pinned: boolean;
  /** The window edge the rail sits on; labels open away from it. */
  side: 'left' | 'right';
  /** What the item opens is in front, or what it toggles is on. */
  active?: boolean;
  /** Joined to the open panel by the connector, which then is its highlight. */
  connected?: boolean;
  disabled?: boolean;
  /** How the carved label ends above and below the item; a shoulder unless said otherwise. */
  above?: RailCarveEnd;
  below?: RailCarveEnd;
  /** A switch that is on, said to assistive technology without lighting the item up. */
  pressed?: boolean;
  /** Drawn on the icon's corner, such as a count. */
  badge?: ReactNode;
  role?: 'tab';
  id?: string;
  controls?: string;
  hasPopup?: 'menu';
  expanded?: boolean;
  tabIndex?: number;
  buttonRef?: Ref<HTMLButtonElement>;
  /** `anchor` is the item's own square (its row when pinned), for a menu to open beside. */
  onClick: (anchor: HTMLElement) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  /** Pointer or focus arrived: the moment to preload what the item opens. */
  onIntent?: () => void;
}

/**
 * One entry of the sidebar rail: a square icon button. While the rail is not
 * pinned its label has no room, so hovering or focusing the item carves the
 * label out of the rail instead — the rail's own edge bends around it, and the
 * rail itself never grows.
 *
 * The item joined to the open panel shows no carved label: the connector
 * already draws that outline there, and the two would cut into each other. It
 * falls back to an ordinary tooltip. Its neighbors carve theirs with a flat
 * end toward it, for the same reason (see {@link RailCarveEnd}).
 */
export const RailItem = memo(function RailItem({
  label,
  shortLabel,
  icon,
  pinned,
  side,
  active = false,
  connected = false,
  above = 'shoulder',
  below = 'shoulder',
  disabled = false,
  pressed,
  badge,
  role,
  id,
  controls,
  hasPopup,
  expanded,
  tabIndex,
  buttonRef,
  onClick,
  onKeyDown,
  onIntent,
}: RailItemProps) {
  const itemRef = useRef<HTMLDivElement>(null);
  const carved = !pinned && !connected;
  const lit = active || connected;
  const away = side === 'left' ? 'right' : 'left';
  // A click answers the label; it steps aside until the pointer comes back.
  const suppress = () => itemRef.current?.setAttribute('data-suppressed', 'true');
  const release = () => itemRef.current?.removeAttribute('data-suppressed');

  const item = (
    <Box
      ref={itemRef}
      className="muxus-rail-item"
      onPointerLeave={release}
      onFocusCapture={release}
      sx={{
        position: 'relative',
        height: RAIL_ITEM_SIZE,
        flexShrink: 0,
        ...(pinned
          ? { mx: `${RAIL_ITEM_INSET_PINNED}px` }
          : {
              [side === 'left' ? 'ml' : 'mr']: `${RAIL_ITEM_INSET}px`,
              [side === 'left' ? 'mr' : 'ml']: '5px',
            }),
        '--rail-item-max-width': pinned ? '100%' : `${RAIL_ITEM_SIZE}px`,
        '--rail-label-opacity': pinned ? 1 : 0,
        '--rail-label-offset': pinned ? '0px' : '-4px',
        '--rail-surface-opacity': 0,
        ...(carved
          ? {
              '@media (hover: hover) and (pointer: fine)': {
                '&:not([data-suppressed]):hover': REVEALED,
              },
              '&:not([data-suppressed]):has(:focus-visible)': REVEALED,
            }
          : {}),
      }}
    >
      <ButtonBase
        ref={buttonRef}
        role={role}
        id={id}
        disabled={disabled}
        tabIndex={tabIndex}
        aria-label={label}
        aria-selected={role === 'tab' ? connected : undefined}
        aria-pressed={role === 'tab' || hasPopup ? undefined : (pressed ?? active) || undefined}
        aria-controls={controls}
        aria-haspopup={hasPopup}
        aria-expanded={expanded}
        onMouseEnter={onIntent}
        onFocus={onIntent}
        onClick={(event) => {
          suppress();
          // The item, not the button: the button is as wide as the label it
          // has just carved out, and a menu anchored to it would open out
          // there, away from the rail.
          onClick(itemRef.current ?? event.currentTarget);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key !== 'Escape' || !carved) return;
          suppress();
        }}
        sx={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          [side]: 0,
          width: pinned ? '100%' : 'max-content',
          maxWidth: 'var(--rail-item-max-width)',
          flexDirection: side === 'left' ? 'row' : 'row-reverse',
          justifyContent: 'flex-start',
          borderRadius: '6px',
          overflow: 'visible',
          color: lit ? 'primary.main' : 'text.secondary',
          transition: `max-width ${RAIL_MOTION}, color ${RAIL_MOTION}`,
          '.muxus-rail-item:hover &, &.Mui-focusVisible': {
            color: lit ? 'primary.main' : 'text.primary',
          },
          // The ring follows the highlighted row, not the label carved beyond the rail.
          '&.Mui-focusVisible': { outline: 'none' },
          '&.Mui-disabled': { opacity: 0.38 },
          '@media (prefers-reduced-motion: reduce)': {
            transition: 'none',
            '& *': { transition: 'none' },
          },
        }}
      >
        {/* Fixed curved pieces meet a flexible end; nothing is stretched. */}
        {carved ? (
          <Box
            aria-hidden
            data-rail-surface
            sx={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              opacity: 'var(--rail-surface-opacity)',
              transition: `opacity ${RAIL_MOTION}`,
              color: 'sidebarEdge',
              transform: side === 'right' ? 'scaleX(-1)' : undefined,
              '& svg': { position: 'absolute', display: 'block', overflow: 'visible' },
              '& [data-fill]': { fill: (theme) => theme.palette.sidebar },
            }}
          >
            <CarveHalf end={above} />
            <CarveHalf end={below} lower />
          </Box>
        ) : null}
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            pointerEvents: 'none',
            bgcolor: active && !connected ? 'action.selected' : 'transparent',
            transition: `background-color ${RAIL_MOTION}`,
            '.muxus-rail-item:hover &': {
              bgcolor: connected ? 'transparent' : active ? 'action.selected' : 'action.hover',
            },
            '.Mui-focusVisible > &': {
              outline: (theme) => `2px solid ${theme.palette.primary.main}`,
              outlineOffset: -2,
            },
          }}
        />
        <Box
          sx={{
            position: 'relative',
            width: RAIL_ITEM_SIZE,
            height: RAIL_ITEM_SIZE,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            '& > svg': { fontSize: 20 },
          }}
        >
          {icon}
          {badge}
        </Box>
        <Box
          component="span"
          data-rail-label
          sx={{
            position: 'relative',
            flexShrink: pinned ? 1 : 0,
            minWidth: 0,
            [side === 'left' ? 'ml' : 'mr']: 1,
            [side === 'left' ? 'mr' : 'ml']: 1.5,
            fontSize: 13,
            fontWeight: 450,
            letterSpacing: -0.1,
            whiteSpace: 'nowrap',
            ...(pinned ? { flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
            textAlign: side === 'left' ? 'left' : 'right',
            pointerEvents: 'none',
            opacity: 'var(--rail-label-opacity)',
            transform:
              side === 'left'
                ? 'translateX(var(--rail-label-offset))'
                : 'translateX(calc(var(--rail-label-offset) * -1))',
            transition: `opacity ${RAIL_MOTION}, transform ${RAIL_MOTION}`,
          }}
        >
          {pinned ? (shortLabel ?? label) : label}
        </Box>
      </ButtonBase>
    </Box>
  );

  // Nothing can be carved where the connector already is, so this one item
  // names itself the ordinary way.
  return !pinned && connected ? (
    <Tooltip title={label} placement={away} enterDelay={400} disableInteractive>
      {item}
    </Tooltip>
  ) : (
    item
  );
});

/** Where the label's surface starts: past the neck that bends it out of the rail. */
const CARVE_NECK = 18;
/** How far the label's surface stands out above and below the item's row. */
const CARVE_OUTSET = 6.5;
/** Corner radius of the label's far end. */
const CARVE_RADIUS = 12;
const HALF_ITEM = RAIL_ITEM_SIZE / 2;

/**
 * The upper half of the carved label's surface, down to the item's middle; the
 * lower half is the same drawing turned over. Everything is laid out from the
 * item's top edge, with the rail's edge 4.5px past the item.
 */
function CarveHalf({ end, lower = false }: { end: RailCarveEnd; lower?: boolean }) {
  // The far end's box, from its top edge down to the item's middle.
  const endTop = end === 'open' ? CARVE_RADIUS : end === 'flat' ? -CARVE_OUTSET - 0.5 : -CARVE_OUTSET;
  return (
    <Box
      sx={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: lower ? HALF_ITEM : 0,
        height: HALF_ITEM,
        transform: lower ? 'scaleY(-1)' : undefined,
      }}
    >
      {/* The neck. Its box starts 18px above the item, where a shoulder leaves the rail's edge. */}
      <svg
        width={CARVE_NECK}
        height={CARVE_NECK + HALF_ITEM}
        viewBox={`0 0 ${CARVE_NECK} ${CARVE_NECK + HALF_ITEM}`}
        fill="none"
        style={{ left: RAIL_ITEM_SIZE, top: -CARVE_NECK }}
      >
        {end === 'shoulder' ? (
          <>
            <path data-fill d="M0 0H4.5Q4.5 12 18 12V36H0Z" />
            <path d="M4.5 0Q4.5 12 18 12H20" stroke="currentColor" />
          </>
        ) : end === 'flat' ? (
          <>
            {/* From the end of the joined item's own edge, straight on; over
                the corner that item would otherwise turn into the panel with. */}
            <path data-fill d="M-6 11.5H18V36H0V22.5H-6Z" />
            <path d="M-5.5 11.5H20" stroke="currentColor" />
          </>
        ) : (
          // Over the sheet's corner and the start of its top edge.
          <path data-fill d="M0 18H18V36H0Z" />
        )}
      </svg>
      <Box
        sx={{
          position: 'absolute',
          left: RAIL_ITEM_SIZE + CARVE_NECK,
          right: -6,
          top: endTop,
          bottom: 0,
          boxSizing: 'border-box',
          bgcolor: 'sidebar',
          borderRight: '1px solid currentColor',
          ...(end === 'open'
            ? {}
            : {
                borderTop: '1px solid currentColor',
                borderTopRightRadius: CARVE_RADIUS,
              }),
        }}
      />
      {end === 'open' ? (
        <>
          <Box
            sx={{
              position: 'absolute',
              left: RAIL_ITEM_SIZE + CARVE_NECK,
              right: -6,
              top: 0,
              height: CARVE_RADIUS,
              bgcolor: 'sidebar',
            }}
          />
          {/* The sheet's corner, moved to the far side of the label: its top
              edge comes down into the label's far edge. */}
          <svg
            width={CARVE_RADIUS}
            height={CARVE_RADIUS + 1}
            viewBox={`0 0 ${CARVE_RADIUS} ${CARVE_RADIUS + 1}`}
            fill="none"
            style={{ left: 'calc(100% + 5.5px)', top: 0 }}
          >
            <path data-fill d="M0 12.5A12 12 0 0 1 12 .5V0H0Z" />
            <path d="M0 12.5A12 12 0 0 1 12 .5" stroke="currentColor" />
          </svg>
        </>
      ) : null}
    </Box>
  );
}
