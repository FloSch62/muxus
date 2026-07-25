import ButtonBase from '@mui/material/ButtonBase';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import { HOST_COLORS } from '../host-organization.js';

/**
 * The host color swatches, shared by the organize dialog and both host
 * editors — colouring a host is the same control wherever you reach it.
 */
export function HostColorPicker({
  value,
  onChange,
  label = 'Color',
  size = 30,
}: {
  value: string | undefined;
  onChange: (color: string | undefined) => void;
  label?: string;
  size?: number;
}) {
  const glyph = Math.round(size * 0.57);
  return (
    <div>
      <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Tooltip title="No color">
          <ButtonBase
            aria-label="No host color"
            onClick={() => onChange(undefined)}
            sx={{
              width: size,
              height: size,
              borderRadius: '50%',
              border: 1,
              borderColor: value ? 'divider' : 'text.secondary',
            }}
          >
            {!value && <CheckIcon sx={{ fontSize: glyph, color: 'text.secondary' }} />}
          </ButtonBase>
        </Tooltip>
        {HOST_COLORS.map((swatch) => (
          <Tooltip key={swatch.value} title={swatch.name}>
            <ButtonBase
              aria-label={`${swatch.name} host color`}
              onClick={() => onChange(swatch.value)}
              sx={{
                width: size,
                height: size,
                borderRadius: '50%',
                bgcolor: swatch.value,
                boxShadow:
                  value === swatch.value
                    ? (theme) =>
                        `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${swatch.value}`
                    : undefined,
                '&:hover': { transform: 'scale(1.08)' },
                transition: 'transform 120ms ease',
              }}
            >
              {value === swatch.value && (
                <CheckIcon sx={{ fontSize: glyph, color: 'rgba(0,0,0,0.68)' }} />
              )}
            </ButtonBase>
          </Tooltip>
        ))}
      </Stack>
    </div>
  );
}
