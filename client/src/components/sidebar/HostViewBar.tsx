import { memo, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import KeyboardDoubleArrowRightIcon from '@mui/icons-material/KeyboardDoubleArrowRight';
import { scopeCrumbs } from '../../host-views.js';
import type { SidebarHostGrouping, SidebarHostView } from '../../state/prefs.js';

const VIEWS: readonly { view: SidebarHostView; label: string; icon: ReactNode }[] = [
  { view: 'tree', label: 'Folder tree', icon: <AccountTreeOutlinedIcon sx={{ fontSize: 15 }} /> },
  { view: 'list', label: 'Flat list', icon: <FormatListBulletedIcon sx={{ fontSize: 15 }} /> },
  {
    view: 'scope',
    label: 'One folder at a time',
    icon: <KeyboardDoubleArrowRightIcon sx={{ fontSize: 15 }} />,
  },
];

const GROUPINGS: readonly { grouping: SidebarHostGrouping; label: string }[] = [
  { grouping: 'recent', label: 'Recent' },
  { grouping: 'name', label: 'A–Z' },
  { grouping: 'kind', label: 'Kind' },
];

/** Chrome text of the bar: the sidebar's label weight and tracking, a size down. */
const textSx = { fontSize: 12, fontWeight: 450, letterSpacing: -0.1 } as const;

/**
 * The strip between the search box and the hosts: how they are laid out, and
 * the one control each layout needs — what the flat list is grouped by, or the
 * way back out of the folder the list is narrowed to.
 */
export const HostViewBar = memo(function HostViewBar({
  view,
  onViewChange,
  grouping,
  onGroupingChange,
  scopePath,
  onScopeChange,
  summary,
  onOpenHostsTab,
}: {
  view: SidebarHostView;
  onViewChange: (view: SidebarHostView) => void;
  grouping: SidebarHostGrouping;
  onGroupingChange: (grouping: SidebarHostGrouping) => void;
  /** The folder in scope; '' at the top. */
  scopePath: string;
  onScopeChange: (path: string) => void;
  /** Said while the tree is showing, such as how many hosts there are. */
  summary: string;
  onOpenHostsTab: () => void;
}) {
  const crumbs = scopeCrumbs(scopePath);
  const parentPath = crumbs.length > 1 ? crumbs[crumbs.length - 2]!.path : '';

  return (
    <Stack
      direction="row"
      useFlexGap
      sx={{ alignItems: 'center', gap: 0.5, minHeight: 24, px: 1.25, pt: 0.25, pb: 0.75 }}
    >
      {view === 'tree' ? (
        <Box
          component="span"
          sx={{
            ...textSx,
            flex: 1,
            minWidth: 0,
            pl: 0.25,
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {summary}
        </Box>
      ) : view === 'list' ? (
        <Stack
          direction="row"
          component="fieldset"
          aria-label="Group hosts by"
          useFlexGap
          sx={{ flex: 1, minWidth: 0, gap: 0.25, m: 0, p: 0, border: 0 }}
        >
          {GROUPINGS.map((entry) => {
            const checked = entry.grouping === grouping;
            return (
              <ButtonBase
                key={entry.grouping}
                aria-pressed={checked}
                onClick={() => onGroupingChange(entry.grouping)}
                sx={{
                  ...textSx,
                  height: 22,
                  px: 0.875,
                  borderRadius: '6px',
                  color: checked ? 'text.primary' : 'text.secondary',
                  bgcolor: checked ? 'action.selected' : 'transparent',
                  '&:hover': { color: 'text.primary' },
                  '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 },
                }}
              >
                {entry.label}
              </ButtonBase>
            );
          })}
        </Stack>
      ) : (
        <Stack
          direction="row"
          component="nav"
          aria-label="Folder in scope"
          sx={{ flex: 1, minWidth: 0, alignItems: 'center' }}
        >
          <Tooltip title={crumbs.length > 0 ? 'Up one folder (Backspace)' : ''}>
            <span style={{ display: 'flex' }}>
              <IconButton
                size="small"
                aria-label="Up one folder"
                disabled={crumbs.length === 0}
                onClick={() => onScopeChange(parentPath)}
                sx={{ p: 0.125, mr: 0.25 }}
              >
                <ChevronLeftIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Stack
            direction="row"
            sx={{
              flex: 1,
              minWidth: 0,
              alignItems: 'center',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              // The deepest folder is the one that has to stay readable.
              justifyContent: 'flex-start',
            }}
          >
            {[{ label: 'All hosts', path: '' }, ...crumbs].map((crumb, index, all) => {
              const current = index === all.length - 1;
              return (
                <Box key={crumb.path} sx={{ display: 'flex', alignItems: 'center', minWidth: current ? 0 : undefined, flexShrink: current ? 1 : 0 }}>
                  {index > 0 ? (
                    <Box component="span" aria-hidden sx={{ ...textSx, px: 0.25, color: 'text.disabled' }}>
                      /
                    </Box>
                  ) : null}
                  <ButtonBase
                    aria-current={current ? 'location' : undefined}
                    onClick={() => onScopeChange(crumb.path)}
                    sx={{
                      ...textSx,
                      height: 22,
                      px: 0.375,
                      minWidth: 0,
                      borderRadius: '4px',
                      color: current ? 'text.primary' : 'text.secondary',
                      fontWeight: current ? 550 : 450,
                      '&:hover': { color: 'text.primary' },
                      '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 },
                    }}
                  >
                    <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {crumb.label}
                    </Box>
                  </ButtonBase>
                </Box>
              );
            })}
          </Stack>
        </Stack>
      )}
      <Stack
        direction="row"
        component="fieldset"
        aria-label="Host layout"
        sx={{
          flexShrink: 0,
          m: 0,
          p: 0,
          minWidth: 0,
          border: 1,
          borderColor: 'divider',
          borderRadius: '7px',
          overflow: 'hidden',
        }}
      >
        {VIEWS.map((entry) => {
          const checked = entry.view === view;
          return (
            <Tooltip key={entry.view} title={entry.label}>
              <ButtonBase
                aria-pressed={checked}
                aria-label={entry.label}
                onClick={() => onViewChange(entry.view)}
                sx={{
                  width: 26,
                  height: 22,
                  color: checked ? 'text.primary' : 'text.secondary',
                  bgcolor: checked ? 'action.selected' : 'transparent',
                  '&:hover': { color: 'text.primary' },
                  '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 },
                }}
              >
                {entry.icon}
              </ButtonBase>
            </Tooltip>
          );
        })}
      </Stack>
      <Tooltip title="Open the hosts as a tab">
        <IconButton
          size="small"
          aria-label="Open the hosts as a tab"
          onClick={onOpenHostsTab}
          sx={{ p: 0.375, flexShrink: 0 }}
        >
          <GridViewOutlinedIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
});
