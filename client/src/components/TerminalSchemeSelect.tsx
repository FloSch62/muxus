import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {
  TERMINAL_SCHEMES,
  terminalScheme,
  type TerminalScheme,
} from '../terminal/palette.js';

const TERMINAL_SCHEME_GROUPS = [
  { label: 'Light schemes', schemes: TERMINAL_SCHEMES.filter((scheme) => scheme.light) },
  { label: 'Dark schemes', schemes: TERMINAL_SCHEMES.filter((scheme) => !scheme.light) },
] as const;

const SCHEME_SWATCH_COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const;

/** Shared scheme picker for global preferences and per-host overrides. */
export function TerminalSchemeSelect({
  id,
  label,
  value,
  inheritLabel,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  inheritLabel?: string;
  onChange: (value: string) => void;
}) {
  const labelId = `${id}-label`;
  return (
    <FormControl fullWidth>
      <InputLabel id={labelId} shrink={inheritLabel ? true : undefined}>{label}</InputLabel>
      <Select
        id={id}
        labelId={labelId}
        value={value}
        label={label}
        displayEmpty={Boolean(inheritLabel)}
        onChange={(event) => onChange(event.target.value)}
        renderValue={(schemeId) =>
          !schemeId && inheritLabel ? (
            <Typography variant="body2" color="text.secondary">
              {inheritLabel}
            </Typography>
          ) : (
            <SchemeLabel scheme={terminalScheme(schemeId)} showMode />
          )
        }
        MenuProps={{ slotProps: { paper: { sx: { maxHeight: 390 } } } }}
      >
        {inheritLabel ? <MenuItem value="">{inheritLabel}</MenuItem> : null}
        {TERMINAL_SCHEME_GROUPS.flatMap((group) => [
          <ListSubheader key={group.label}>{group.label}</ListSubheader>,
          ...group.schemes.map((scheme) => (
            <MenuItem key={scheme.id} value={scheme.id}>
              <SchemeLabel scheme={scheme} />
            </MenuItem>
          )),
        ])}
      </Select>
    </FormControl>
  );
}

/** Compact terminal preview used by both the closed selector and its menu. */
function SchemeLabel({ scheme, showMode = false }: { scheme: TerminalScheme; showMode?: boolean }) {
  const theme = scheme.theme;
  return (
    <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', width: '100%', minWidth: 0 }}>
      <Box
        aria-hidden
        sx={{
          width: 60,
          height: 28,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '3px',
          bgcolor: theme.background,
          border: 1,
          borderColor: scheme.light ? 'rgba(0, 0, 0, 0.14)' : 'rgba(255, 255, 255, 0.14)',
          borderRadius: 0.75,
        }}
      >
        {SCHEME_SWATCH_COLORS.map((color) => (
          <Box
            key={color}
            sx={{ width: 5, height: 12, borderRadius: '2px', bgcolor: theme[color] }}
          />
        ))}
      </Box>
      <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
        {scheme.name}
      </Typography>
      {showMode ? (
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto !important', pr: 0.5 }}>
          {scheme.light ? 'Light' : 'Dark'}
        </Typography>
      ) : null}
    </Stack>
  );
}
