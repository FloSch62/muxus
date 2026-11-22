import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import type { SavedHostProfile } from '@muxus/shared';
import {
  HOST_ICON_SECTIONS,
  hostIconEntry,
  searchHostIcons,
  type HostIconEntry,
} from '../host-icon-catalog.js';
import { hostIcon } from './host-icon.js';

const CELL = 32;
const CELL_GAP = 4;
const COLUMNS = 9;
const PADDING = 12;

/**
 * The icon a host shows in every list and on its tabs. One control wherever a
 * host's look is edited, beside the color swatches it is tinted by.
 */
export function HostIconPicker({
  value,
  onChange,
  kind = 'ssh',
  color,
  label = 'Icon',
  mixed = false,
}: {
  value: string | undefined;
  onChange: (icon: string | undefined) => void;
  /** Decides the icon shown for "Default". */
  kind?: SavedHostProfile['kind'];
  /** The host's color, which tints its icon everywhere else too. */
  color?: string;
  label?: string;
  /** Several hosts with different icons: nothing is chosen, not even the default. */
  mixed?: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const grid = useRef<HTMLDivElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const entry = mixed ? undefined : hostIconEntry(value);
  const Current = hostIcon(entry?.id, kind);
  const DefaultIcon = hostIcon(undefined, kind);
  const matches = useMemo(() => searchHostIcons(query), [query]);
  const searching = query.trim().length > 0;
  const showDefault = !searching || 'default'.includes(query.trim().toLowerCase());

  useEffect(() => {
    if (!anchor) return;
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [anchor]);

  const close = () => {
    setAnchor(null);
    setQuery('');
  };
  const choose = (icon: string | undefined) => {
    onChange(icon);
    close();
  };

  /** Arrow keys walk the cells by where they are drawn, across the sections. */
  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
    const cells = [...(grid.current?.querySelectorAll<HTMLElement>('[data-icon-cell]') ?? [])];
    if (cells.length === 0) return;
    event.preventDefault();
    const index = cells.indexOf(document.activeElement as HTMLElement);
    if (index < 0 || key === 'Home') return cells[0]?.focus();
    if (key === 'End') return cells.at(-1)?.focus();
    if (key === 'ArrowLeft') return cells[Math.max(0, index - 1)]?.focus();
    if (key === 'ArrowRight') return cells[Math.min(cells.length - 1, index + 1)]?.focus();
    const from = cells[index]!.getBoundingClientRect();
    const down = key === 'ArrowDown';
    const beyond = cells
      .map((cell) => ({ cell, rect: cell.getBoundingClientRect() }))
      .filter(({ rect }) => (down ? rect.top > from.top + 1 : rect.top < from.top - 1));
    if (beyond.length === 0) return;
    const rowTop = down
      ? Math.min(...beyond.map(({ rect }) => rect.top))
      : Math.max(...beyond.map(({ rect }) => rect.top));
    beyond
      .filter(({ rect }) => Math.abs(rect.top - rowTop) < 1)
      .sort((a, b) => Math.abs(a.rect.left - from.left) - Math.abs(b.rect.left - from.left))[0]
      ?.cell.focus();
  };

  const cell = (icon: HostIconEntry) => {
    const Glyph = hostIcon(icon.id, kind);
    const selected = entry?.id === icon.id;
    return (
      <Tooltip key={icon.id} title={icon.label} disableInteractive enterDelay={250} placement="top">
        <ButtonBase
          data-icon-cell
          aria-label={`${icon.label} host icon`}
          aria-pressed={selected}
          onClick={() => choose(icon.id)}
          sx={{
            width: CELL,
            height: CELL,
            borderRadius: 1,
            border: 1,
            borderColor: selected ? 'primary.main' : 'transparent',
            color: selected ? (color ?? 'primary.main') : 'text.secondary',
            '&:hover, &.Mui-focusVisible': { bgcolor: 'action.hover', color: color ?? 'text.primary' },
          }}
        >
          <Glyph sx={{ fontSize: 18 }} />
        </ButtonBase>
      </Tooltip>
    );
  };

  return (
    <div>
      <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
        {label}
      </Typography>
      <ButtonBase
        aria-label={`Host icon: ${mixed ? 'mixed' : (entry?.label ?? 'default')}`}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{
          height: 30,
          pl: 1,
          pr: 0.5,
          gap: 0.75,
          borderRadius: 1,
          border: 1,
          borderColor: anchor ? 'primary.main' : 'divider',
          '&:hover': { borderColor: anchor ? 'primary.main' : 'text.secondary' },
        }}
      >
        {!mixed && <Current sx={{ fontSize: 17, color: color ?? 'text.secondary' }} />}
        <Typography variant="body2" color={mixed ? 'textSecondary' : 'textPrimary'}>
          {mixed ? 'Mixed' : (entry?.label ?? 'Default')}
        </Typography>
        <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
      </ButtonBase>

      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              width: COLUMNS * CELL + (COLUMNS - 1) * CELL_GAP + 2 * PADDING,
              maxWidth: 'calc(100vw - 24px)',
              mt: 0.75,
              overflow: 'hidden',
            },
          },
        }}
      >
        <Box sx={{ p: `${PADDING}px`, pb: 1 }}>
          <TextField
            inputRef={searchInput}
            fullWidth
            size="small"
            placeholder="Search icons"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                // The form around the picker must not take this Enter as its submit.
                event.stopPropagation();
                if (matches[0] && searching) choose(matches[0].id);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                grid.current?.querySelector<HTMLElement>('[data-icon-cell]')?.focus();
              }
            }}
            slotProps={{
              htmlInput: { 'aria-label': 'Search icons' },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
        </Box>
        <Divider />
        <Box
          ref={grid}
          onKeyDown={moveFocus}
          sx={{ maxHeight: 372, overflowY: 'auto', px: `${PADDING}px`, pt: 0.75, pb: 1.25 }}
        >
          {showDefault && (
            <ButtonBase
              data-icon-cell
              aria-pressed={!mixed && !entry}
              onClick={() => choose(undefined)}
              sx={{
                width: '100%',
                height: CELL,
                mt: 0.5,
                px: '7px',
                gap: 1,
                justifyContent: 'flex-start',
                borderRadius: 1,
                border: 1,
                borderColor: !mixed && !entry ? 'primary.main' : 'transparent',
                color: 'text.secondary',
                '&:hover, &.Mui-focusVisible': { bgcolor: 'action.hover' },
              }}
            >
              <DefaultIcon sx={{ fontSize: 18 }} />
              <Typography variant="body2" color="textPrimary">
                Default
              </Typography>
              <Typography variant="caption" color="textSecondary" sx={{ ml: 'auto' }}>
                follows the connection type
              </Typography>
              {!mixed && !entry && <CheckIcon sx={{ fontSize: 16, color: 'primary.main' }} />}
            </ButtonBase>
          )}
          {HOST_ICON_SECTIONS.map((section) => {
            const icons = matches.filter((icon) => icon.section === section.id);
            if (icons.length === 0) return null;
            return (
              <Box key={section.id}>
                <Typography
                  component="div"
                  sx={{
                    mt: 1.25,
                    mb: 0.5,
                    fontSize: 10.5,
                    lineHeight: '18px',
                    textTransform: 'uppercase',
                    letterSpacing: 0.65,
                    color: 'text.secondary',
                  }}
                >
                  {section.label}
                </Typography>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${COLUMNS}, ${CELL}px)`,
                    justifyContent: 'space-between',
                    rowGap: `${CELL_GAP}px`,
                  }}
                >
                  {icons.map(cell)}
                </Box>
              </Box>
            );
          })}
          {matches.length === 0 && !showDefault && (
            <Typography variant="body2" color="textSecondary" sx={{ py: 3, textAlign: 'center' }}>
              No icon matches “{query.trim()}”.
            </Typography>
          )}
        </Box>
      </Popover>
    </div>
  );
}
