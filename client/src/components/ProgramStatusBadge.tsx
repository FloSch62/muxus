import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import CancelRoundedIcon from '@mui/icons-material/CancelRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import HelpRoundedIcon from '@mui/icons-material/HelpRounded';
import { useTabProgramStatus } from '../state/program-status.js';
import { usePrefsStore } from '../state/prefs.js';
import { programStatusLabel } from '../terminal/program-status.js';

const iconSx = { fontSize: 14, flexShrink: 0 } as const;

/**
 * What a program in the tab reported with OSC 7501: a ring while it works,
 * a question mark while it waits for the user, and a check or cross until the
 * finished tab is looked at. The text comes from the program and React
 * renders it as plain text.
 */
export function ProgramStatusBadge({ tabId, sx }: { tabId: string; sx?: SxProps<Theme> }) {
  const enabled = usePrefsStore((state) => state.showProgramStatus);
  const record = useTabProgramStatus(tabId);
  if (!enabled || !record) return null;

  const label = programStatusLabel(record);
  const source = [record.app, record.title].filter(Boolean).join(': ');
  const ariaLabel = source ? `${label}: ${source}` : label;
  const tooltip = (
    <Box component="span" sx={{ display: 'block', maxWidth: 320, overflowWrap: 'anywhere' }}>
      <Box component="span" sx={{ display: 'block', fontWeight: 600 }}>
        {label}
      </Box>
      {source ? <Box component="span" sx={{ display: 'block' }}>{source}</Box> : null}
      {record.msg ? (
        <Box component="span" sx={{ display: 'block', opacity: 0.85 }}>
          {record.msg}
        </Box>
      ) : null}
    </Box>
  );

  let icon;
  switch (record.state) {
    case 'working':
      icon = (
        <CircularProgress
          aria-label={ariaLabel}
          variant={record.progress === undefined ? 'indeterminate' : 'determinate'}
          value={record.progress}
          size={12}
          thickness={6}
          color="info"
          sx={{ flexShrink: 0, mx: 0.125 }}
        />
      );
      break;
    case 'blocked':
      icon = (
        <HelpRoundedIcon
          aria-label={ariaLabel}
          color="warning"
          sx={{
            ...iconSx,
            animation: 'muxus-pulse 1.2s ease-in-out infinite',
            '@keyframes muxus-pulse': { '50%': { opacity: 0.35 } },
          }}
        />
      );
      break;
    case 'done':
      icon = <CheckCircleRoundedIcon aria-label={ariaLabel} color="success" sx={iconSx} />;
      break;
    case 'error':
      icon = <CancelRoundedIcon aria-label={ariaLabel} color="error" sx={iconSx} />;
      break;
    default:
      return null;
  }

  return (
    <Tooltip title={tooltip} placement="bottom">
      <Box component="span" sx={[{ display: 'inline-flex', flexShrink: 0 }, ...(Array.isArray(sx) ? sx : [sx])]}>
        {icon}
      </Box>
    </Tooltip>
  );
}
