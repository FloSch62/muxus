import Box from '@mui/material/Box';
import { alpha, type Theme } from '@mui/material/styles';
import { commandButtonInk, type CommandButtonColor } from '../command-buttons.js';

/**
 * An accented command button: its ink for the label, a softer border and a
 * faint wash. A disabled one fades but keeps its hue, so the colors still
 * identify buttons while no terminal is connected.
 */
export function commandButtonColorSx(color: CommandButtonColor | undefined) {
  return (theme: Theme) => {
    if (!color) return {};
    const ink = commandButtonInk(color, theme.palette.mode);
    return {
      color: ink,
      borderColor: alpha(ink, 0.45),
      bgcolor: alpha(ink, theme.palette.mode === 'dark' ? 0.1 : 0.07),
      '&:hover': {
        borderColor: ink,
        bgcolor: alpha(ink, theme.palette.mode === 'dark' ? 0.18 : 0.13),
      },
      '&.Mui-disabled': {
        color: alpha(ink, 0.45),
        borderColor: alpha(ink, 0.2),
        bgcolor: alpha(ink, 0.04),
      },
    };
  };
}

/** The small round mark a colored command carries in lists and pickers. */
export function CommandButtonColorDot({
  color,
  size = 8,
}: {
  color: CommandButtonColor | undefined;
  size?: number;
}) {
  return (
    <Box
      component="span"
      aria-hidden
      sx={(theme) => ({
        display: 'inline-block',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        ...(color
          ? { bgcolor: commandButtonInk(color, theme.palette.mode) }
          : { border: 1, borderColor: 'text.disabled' }),
      })}
    />
  );
}
