import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { layout } from '../../theme.js';

/**
 * The title row a sidebar panel opens with: what it shows, and its few
 * actions. It is as tall as a pane's tab strip and ends on the same hairline,
 * so the line under it carries on across the gap into the panes.
 *
 * Icon buttons passed as actions get one size here, whatever they ask for.
 */
export function PanelHeader({
  icon,
  title,
  caption,
  children,
}: {
  /** The panel's own icon, as on its rail item. */
  icon: ReactNode;
  title: ReactNode;
  /** Said quietly after the title, such as the protocol. */
  caption?: ReactNode;
  /** Actions, at the far end. */
  children?: ReactNode;
}) {
  return (
    <Stack
      direction="row"
      useFlexGap
      sx={{
        height: layout.tabStripHeight,
        flexShrink: 0,
        boxSizing: 'border-box',
        // A tab's label sits under its 2px color stripe; the title sits level with it.
        pt: '2px',
        pl: 1.5,
        pr: 0.75,
        gap: 0.25,
        alignItems: 'center',
        borderBottom: 1,
        borderColor: 'divider',
        '& .MuiIconButton-root': { p: '5px' },
        '& .MuiIconButton-root .MuiSvgIcon-root': { fontSize: 18 },
      }}
    >
      <Box
        aria-hidden
        sx={{
          display: 'flex',
          mr: 0.75,
          color: 'primary.main',
          '& .MuiSvgIcon-root': { fontSize: 18 },
        }}
      >
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {typeof title === 'string' ? (
          <Typography variant="subtitle2" noWrap>
            {title}
          </Typography>
        ) : (
          title
        )}
      </Box>
      {caption ? (
        <Typography variant="caption" color="textSecondary" noWrap sx={{ mx: 0.5, flexShrink: 0 }}>
          {caption}
        </Typography>
      ) : null}
      {children}
    </Stack>
  );
}
