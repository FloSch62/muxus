import { useState, type ComponentType, type MouseEvent, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import type { Theme } from '@mui/material/styles';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import { statusTextColor } from '../../theme.js';

export const MONO = { fontFamily: '"JetBrains Mono", monospace' } as const;

/** Indent of one tree level, in px. */
const LEVEL = 16;

/** Label and value pairs shown when the pointer rests on a line; empty values are left out. */
export type LineHint = readonly (readonly [label: string, value: string | number | undefined | null | false])[];

function HintCard({ title, hint }: { title: string; hint: LineHint }) {
  const rows = hint.filter((row): row is readonly [string, string | number] => row[1] !== undefined && row[1] !== null && row[1] !== false && row[1] !== '');
  return (
    <Box sx={{ py: 0.25 }}>
      <Box sx={{ fontWeight: 600, fontSize: 12, wordBreak: 'break-all', mb: rows.length ? 0.5 : 0 }}>{title}</Box>
      {rows.length ? (
        <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1, rowGap: 0.25 }}>
          {rows.map(([label, value], index) => (
            <Box key={index} sx={{ display: 'contents' }}>
              {label ? (
                <Box component="dt" sx={{ opacity: 0.7 }}>
                  {label}
                </Box>
              ) : null}
              <Box
                component="dd"
                sx={{ m: 0, ...MONO, fontSize: 11, wordBreak: 'break-all', ...(label ? {} : { gridColumn: '1 / -1' }) }}
              >
                {value}
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * One line of the panel's tree: chevron, icon, name with a dim detail, a
 * status column, and the line's own actions. Hosts, providers, groups and
 * items all use it, so every level reads the same way.
 */
export function TreeLine({
  depth,
  open,
  onToggle,
  icon,
  title,
  detail,
  status,
  actions,
  onOpen,
  emphasis = false,
  dim = false,
  selected = false,
  label,
  hint,
}: {
  depth: number;
  /** undefined: a leaf, no chevron. */
  open?: boolean;
  onToggle?: () => void;
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  /** Double-click or Enter: the line's main action. */
  onOpen?: () => void;
  emphasis?: boolean;
  dim?: boolean;
  selected?: boolean;
  /** Accessible name when the title is not plain text. */
  label?: string;
  /** Details shown on hover, under the full name. Plain-text detail and status are shown by default. */
  hint?: LineHint;
}) {
  const expandable = open !== undefined;
  const name = label ?? (typeof title === 'string' ? title : undefined);
  const hintRows: LineHint = hint ?? [
    ['', typeof detail === 'string' ? detail : undefined],
    ['', typeof status === 'string' ? status : undefined],
  ];
  // Without details of its own, a line explains itself only when its text is cut off.
  const [clipped, setClipped] = useState(false);
  const measure = (event: MouseEvent<HTMLElement>) => {
    if (hint) return;
    const spans = event.currentTarget.querySelectorAll<HTMLElement>('[data-clip]');
    setClipped([...spans].some((span) => span.scrollWidth > span.clientWidth));
  };
  return (
    <Box
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      aria-level={depth + 1}
      tabIndex={0}
      onClick={expandable ? onToggle : undefined}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' && onOpen) {
          event.preventDefault();
          onOpen();
        } else if ((event.key === 'ArrowRight' && open === false) || (event.key === 'ArrowLeft' && open === true)) {
          event.preventDefault();
          onToggle?.();
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        minHeight: 30,
        pl: `${8 + depth * LEVEL}px`,
        pr: 0.75,
        cursor: expandable ? 'pointer' : onOpen ? 'default' : 'default',
        bgcolor: selected ? 'action.selected' : 'transparent',
        opacity: dim ? 0.62 : 1,
        outline: 'none',
        '&:hover': { bgcolor: 'action.hover' },
        '&:focus-visible': { boxShadow: (theme: Theme) => `inset 0 0 0 2px ${theme.palette.primary.main}` },
        '&:hover .line-actions, &:focus-within .line-actions': { opacity: 1 },
      }}
    >
      <Box sx={{ width: 16, display: 'flex', flexShrink: 0, color: 'text.secondary' }}>
        {expandable ? (
          open ? (
            <ExpandMoreIcon sx={{ fontSize: 16 }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 16 }} />
          )
        ) : null}
      </Box>
      {icon ? <Box sx={{ display: 'flex', flexShrink: 0 }}>{icon}</Box> : null}
      <Tooltip
        title={name && (hint || clipped) ? <HintCard title={name} hint={hintRows} /> : ''}
        placement="bottom-start"
        enterDelay={500}
        enterNextDelay={300}
        disableInteractive
        slotProps={{ tooltip: { sx: { maxWidth: 420 } } }}
      >
        <Box
          onMouseEnter={measure}
          sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 0.75 }}
        >
          <Box
            component="span"
            data-clip
            sx={{
              fontSize: 13,
              fontWeight: emphasis ? 600 : 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            {title}
          </Box>
          {detail ? (
            <Box
              component="span"
              data-clip
              sx={{
                fontSize: 11,
                color: 'text.secondary',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                flexShrink: 100,
                minWidth: 0,
              }}
            >
              {detail}
            </Box>
          ) : null}
        </Box>
      </Tooltip>
      {status ? (
        <Box
          sx={{
            fontSize: 11,
            color: 'text.secondary',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            maxWidth: '38%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {status}
        </Box>
      ) : null}
      {actions ? (
        <Box
          className="line-actions"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          sx={{ display: 'flex', flexShrink: 0, opacity: { xs: 1, md: 0.55 }, transition: 'opacity 120ms ease' }}
        >
          {actions}
        </Box>
      ) : null}
    </Box>
  );
}

/** A row action: an icon button with its name as tooltip and accessible label. */
export function LineAction({
  label,
  Icon,
  onClick,
  disabled,
  color,
}: {
  label: string;
  Icon: ComponentType<SvgIconProps>;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  disabled?: boolean;
  color?: string;
}) {
  return (
    <Tooltip title={label} disableInteractive>
      <span>
        <IconButton size="small" aria-label={label} disabled={disabled} onClick={onClick} sx={{ p: 0.5 }}>
          <Icon sx={{ fontSize: 16, ...(color ? { color } : {}) }} />
        </IconButton>
      </span>
    </Tooltip>
  );
}

export interface MenuEntry {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  divider?: boolean;
}

/** The "…" button with the rest of a line's actions. */
export function LineMenu({ label, entries }: { label: string; entries: readonly MenuEntry[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (entries.length === 0) return null;
  return (
    <>
      <LineAction label={label} Icon={MoreHorizIcon} onClick={(event) => setAnchor(event.currentTarget)} />
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {entries.map((entry) => (
          <MenuItem
            key={entry.label}
            dense
            divider={entry.divider}
            disabled={entry.disabled}
            onClick={() => {
              setAnchor(null);
              entry.onClick();
            }}
            sx={entry.destructive ? { color: statusTextColor('error') } : undefined}
          >
            {entry.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export type Health = 'up' | 'warn' | 'down' | 'off';

export function StatusDot({ health }: { health: Health }) {
  return (
    <Box
      aria-hidden
      sx={(theme) => ({
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        ...(health === 'off'
          ? { border: `1.5px solid ${theme.palette.text.disabled}` }
          : {
              bgcolor:
                health === 'up'
                  ? theme.palette.success.main
                  : health === 'warn'
                    ? theme.palette.warning.main
                    : theme.palette.error.main,
            }),
      })}
    />
  );
}

/** A service a host serves, opened in the browser through a forward when needed. */
export function PortChip({ label, title, onClick, disabled }: { label: string; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip title={title} disableInteractive>
      <span>
        <ButtonBase
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          sx={{
            ...(disabled ? { opacity: 0.5 } : {}),
            height: 20,
            px: 0.75,
            gap: 0.5,
            borderRadius: 10,
            border: 1,
            borderColor: 'divider',
            fontSize: 11,
            ...MONO,
            color: 'text.secondary',
            '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
          }}
        >
          {label}
          <OpenInNewOutlinedIcon sx={{ fontSize: 11 }} />
        </ButtonBase>
      </span>
    </Tooltip>
  );
}

/** Port chips under an item, indented to its title. */
export function ChipRow({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <Box
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, pl: `${8 + depth * LEVEL + 16 + 6 + 14}px`, pr: 1, pb: 0.75 }}
    >
      {children}
    </Box>
  );
}

/** A short note under an item, such as why a pod is not running. */
export function NoteLine({
  depth,
  tone = 'secondary',
  children,
}: {
  depth: number;
  tone?: 'secondary' | 'error' | 'warning';
  children: ReactNode;
}) {
  return (
    <Box
      sx={(theme) => ({
        pl: `${8 + depth * LEVEL + 22}px`,
        pr: 1,
        pb: 0.5,
        fontSize: 11,
        color: tone === 'secondary' ? theme.palette.text.secondary : statusTextColor(tone)(theme),
      })}
    >
      {children}
    </Box>
  );
}

/**
 * Which lines are open. Each line has its own default, so lists the user
 * never touched open the way their kind suggests.
 */
export function useExpansion() {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isOpen = (key: string, fallback: boolean) => overrides.get(key) ?? fallback;
  const toggle = (key: string, fallback: boolean) =>
    setOverrides((current) => new Map(current).set(key, !(current.get(key) ?? fallback)));
  return { isOpen, toggle };
}

export type Expansion = ReturnType<typeof useExpansion>;
