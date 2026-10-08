import Box from '@mui/material/Box';
import { alpha, type Theme } from '@mui/material/styles';
import type {
  CommandBarPosition,
  FileBrowserPosition,
  SidebarPosition,
} from '../state/prefs.js';

const WIDTH = 200;
const HEIGHT = 126;
/** Children are placed inside the 1px frame. */
const INNER_WIDTH = WIDTH - 2;
const INNER_HEIGHT = HEIGHT - 2;
const TOP_BAR = 13;
const COMMAND_BAR = 11;
const SIDEBAR = 58;
/** The vertical tabs that appear with the file browser docked in the sidebar. */
const RAIL = 10;
const FILE_PANEL = 46;
const TAB_STRIP = 10;

const motion = {
  transition: 'left 220ms ease, right 220ms ease, top 220ms ease, bottom 220ms ease',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
};

type ThemeColor = (theme: Theme) => string;

const ink =
  (strength: number): ThemeColor =>
  (theme) =>
    alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? strength : strength * 0.8);

/** One rounded stroke standing in for a line of text. */
function Line({
  width,
  color = ink(0.16),
  indent = 0,
}: {
  width: number | string;
  color?: ThemeColor;
  indent?: number;
}) {
  return (
    <Box
      sx={{
        height: 3,
        width,
        ml: `${indent}px`,
        borderRadius: 2,
        flexShrink: 0,
        bgcolor: color,
      }}
    />
  );
}

/**
 * A miniature of the window that follows the layout preferences, so moving the
 * sidebar, the file browser or the command bar is visible before the dialog is
 * closed. Purely decorative: the toggles beside it carry the state for
 * assistive technology.
 */
export function LayoutPreview({
  sidebarPosition,
  fileBrowserPosition,
  commandBarPosition,
}: {
  sidebarPosition: SidebarPosition;
  fileBrowserPosition: FileBrowserPosition;
  commandBarPosition: CommandBarPosition;
}) {
  const sidebarOnRight = sidebarPosition === 'right';
  const filesInSidebar = fileBrowserPosition === 'sidebar';
  const rail = filesInSidebar ? RAIL : 0;
  const barAtBottom = commandBarPosition === 'bottom';
  const mainTop = TOP_BAR + (barAtBottom ? 0 : COMMAND_BAR);
  const mainBottom = barAtBottom ? COMMAND_BAR : 0;

  return (
    <Box
      aria-hidden
      data-layout-preview
      sx={{
        position: 'relative',
        width: WIDTH,
        height: HEIGHT,
        flexShrink: 0,
        overflow: 'hidden',
        borderRadius: 1.5,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'background.default',
        boxShadow: (theme) =>
          `0 1px 2px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.4 : 0.06)}`,
      }}
    >
      {/* Top bar: logo mark on the left, a few controls on the right. */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          bottom: 'auto',
          height: TOP_BAR,
          display: 'flex',
          alignItems: 'center',
          gap: '3px',
          px: '6px',
          bgcolor: 'sidebar',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ width: 5, height: 5, borderRadius: 0.5, bgcolor: 'primary.main' }} />
        <Line width={18} color={ink(0.28)} />
        <Box sx={{ flex: 1 }} />
        {[0, 1, 2, 3].map((dot) => (
          <Box key={dot} sx={{ width: 4, height: 4, borderRadius: '50%', bgcolor: ink(0.22) }} />
        ))}
      </Box>

      {/* Command bar: a few outlined buttons and the manage control. */}
      <Box
        data-preview-part="command-bar"
        sx={{
          ...motion,
          position: 'absolute',
          left: 0,
          right: 0,
          top: barAtBottom ? INNER_HEIGHT - COMMAND_BAR : TOP_BAR,
          height: COMMAND_BAR,
          display: 'flex',
          alignItems: 'center',
          gap: '3px',
          px: '5px',
          bgcolor: 'sidebar',
          [barAtBottom ? 'borderTop' : 'borderBottom']: 1,
          borderColor: 'divider',
          zIndex: 1,
        }}
      >
        {[16, 22, 13].map((width) => (
          <Box
            key={width}
            sx={{
              width,
              height: 5,
              borderRadius: 0.5,
              border: 1,
              borderColor: (theme) => alpha(theme.palette.primary.main, 0.7),
            }}
          />
        ))}
        <Box sx={{ flex: 1 }} />
        <Box sx={{ width: 4, height: 4, borderRadius: '50%', bgcolor: ink(0.22) }} />
      </Box>

      {/* Vertical tabs at the window edge: hosts in front, the file browser behind. */}
      {filesInSidebar ? (
        <Box
          data-preview-part="rail"
          sx={{
            position: 'absolute',
            top: mainTop,
            bottom: mainBottom,
            left: sidebarOnRight ? INNER_WIDTH - RAIL : 0,
            width: RAIL,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '3px',
            pt: '5px',
            bgcolor: 'sidebar',
            [sidebarOnRight ? 'borderLeft' : 'borderRight']: 1,
            borderColor: 'divider',
          }}
        >
          <Box sx={{ width: 5, height: 5, borderRadius: 0.5, bgcolor: ink(0.34) }} />
          <Box sx={{ width: 5, height: 5, borderRadius: 0.5, bgcolor: ink(0.14) }} />
        </Box>
      ) : null}

      {/* Hosts sidebar: search box, then a short tree with one live host. */}
      <Box
        data-preview-part="sidebar"
        sx={{
          ...motion,
          position: 'absolute',
          top: mainTop,
          bottom: mainBottom,
          left: sidebarOnRight ? INNER_WIDTH - rail - SIDEBAR : rail,
          width: SIDEBAR,
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          p: '5px',
          bgcolor: 'sidebar',
          [sidebarOnRight ? 'borderLeft' : 'borderRight']: 1,
          borderColor: 'divider',
        }}
      >
        <Box
          sx={{
            height: 6,
            mb: '2px',
            borderRadius: 0.5,
            border: 1,
            borderColor: ink(0.14),
            flexShrink: 0,
          }}
        />
        <Line width="70%" />
        <Line width="52%" indent={5} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '2px', ml: '5px' }}>
          <Box sx={{ width: 3, height: 3, borderRadius: '50%', bgcolor: 'success.main' }} />
          <Line width={22} />
        </Box>
        <Line width="60%" />
        <Line width="44%" indent={5} />
      </Box>

      {/* Pane canvas: a tab strip over a terminal with a prompt and cursor. */}
      <Box
        data-preview-part="panes"
        sx={{
          ...motion,
          position: 'absolute',
          top: mainTop,
          bottom: mainBottom,
          left: sidebarOnRight ? 0 : SIDEBAR + rail,
          right: sidebarOnRight ? SIDEBAR + rail : 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box
          sx={{
            height: TAB_STRIP,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'flex-end',
            px: '4px',
            bgcolor: 'sidebar',
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Box
            sx={{
              width: 34,
              height: 7,
              display: 'flex',
              alignItems: 'center',
              gap: '2px',
              px: '3px',
              borderRadius: '2px 2px 0 0',
              bgcolor: 'background.default',
            }}
          >
            <Box sx={{ width: 3, height: 3, borderRadius: '50%', bgcolor: 'success.main' }} />
            <Line width={16} />
          </Box>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <Box
            sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px', p: '6px' }}
          >
            <Line width="46%" />
            <Line width="68%" />
            <Line width="38%" />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <Line width={14} color={(theme) => alpha(theme.palette.success.main, 0.8)} />
              <Line width={22} />
              <Box sx={{ width: 3, height: 5, bgcolor: 'primary.main', opacity: 0.8 }} />
            </Box>
          </Box>
          {/* The file browser beside its terminal: a path, then a few files. */}
          {filesInSidebar ? null : (
            <Box
              data-preview-part="file-browser"
              sx={{
                width: FILE_PANEL,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                p: '5px',
                bgcolor: 'background.paper',
                borderLeft: 1,
                borderColor: 'divider',
              }}
            >
              <Box
                sx={{
                  height: 6,
                  mb: '2px',
                  borderRadius: 0.5,
                  border: 1,
                  borderColor: ink(0.14),
                  flexShrink: 0,
                }}
              />
              {[70, 55, 80, 48].map((width, index) => (
                <Box key={width} sx={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                  <Box
                    sx={{
                      width: 3,
                      height: 3,
                      borderRadius: 0.25,
                      flexShrink: 0,
                      bgcolor: (theme) =>
                        index < 2 ? alpha(theme.palette.primary.main, 0.7) : ink(0.22)(theme),
                    }}
                  />
                  <Line width={`${width}%`} />
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
