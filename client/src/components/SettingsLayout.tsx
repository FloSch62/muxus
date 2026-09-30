import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { statusTextColor } from '../theme.js';

/**
 * The layout language every Settings section shares: a page heading, then
 * groups (a small uppercase label above a bordered card) holding rows with the
 * label and its explanation on the left and the control on the right.
 */
export function SettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Typography
          variant="h6"
          component="h2"
          sx={{ fontSize: 18, fontWeight: 650, lineHeight: 1.3 }}
        >
          {title}
        </Typography>
        {description ? (
          <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5, maxWidth: 620 }}>
            {description}
          </Typography>
        ) : null}
      </Box>
      {children}
    </Box>
  );
}

export function SettingsGroup({
  title,
  description,
  action,
  flush = false,
  children,
}: {
  title?: string;
  description?: React.ReactNode;
  /** Sits at the end of the label line, e.g. an Add button. */
  action?: React.ReactNode;
  /** No row separators: the children bring their own (lists, forms). */
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box component="section">
      {title || action ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 28, mb: 0.75 }}>
          {title ? (
            <Typography
              variant="caption"
              component="h3"
              sx={{
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'text.secondary',
              }}
            >
              {title}
            </Typography>
          ) : null}
          {action ? (
            <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>{action}</Box>
          ) : null}
        </Box>
      ) : null}
      {description ? (
        <Typography variant="body2" color="textSecondary" sx={{ mb: 1.25, maxWidth: 640 }}>
          {description}
        </Typography>
      ) : null}
      <Box
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          bgcolor: 'background.paper',
          overflow: 'hidden',
          ...(flush
            ? {}
            : { '& > .settings-row + .settings-row': { borderTop: 1, borderColor: 'divider' } }),
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

/**
 * One setting: label and explanation on the left, the control on the right.
 * `stacked` puts a wide control (a path field, a form) under the text.
 * `labelFor` ties the label to its input for screen readers.
 */
export function SettingRow({
  label,
  description,
  control,
  stacked = false,
  labelFor,
  disabled = false,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  stacked?: boolean;
  labelFor?: string;
  /** Greys the text out along with a disabled control. */
  disabled?: boolean;
  /** Extra content under the row (a hint, an alert, a sub-setting). */
  children?: React.ReactNode;
}) {
  return (
    <Box className="settings-row" sx={{ px: 2, py: 1.5 }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: stacked ? 'column' : 'row',
          alignItems: stacked ? 'stretch' : 'center',
          flexWrap: 'wrap',
          gap: stacked ? 1.25 : 2,
          rowGap: 1,
        }}
      >
        <Box sx={{ flex: stacked ? 'none' : '1 1 240px', minWidth: 0 }}>
          <Typography
            variant="body2"
            component={labelFor ? 'label' : 'div'}
            htmlFor={labelFor}
            color={disabled ? 'textDisabled' : undefined}
            sx={{ fontWeight: 550, display: 'block' }}
          >
            {label}
          </Typography>
          {description ? (
            <Typography
              variant="caption"
              color={disabled ? 'textDisabled' : 'textSecondary'}
              component="div"
              sx={{ mt: 0.25, lineHeight: 1.5 }}
            >
              {description}
            </Typography>
          ) : null}
        </Box>
        {control ? (
          <Box
            sx={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              maxWidth: '100%',
              ...(stacked ? {} : { ml: 'auto' }),
            }}
          >
            {control}
          </Box>
        ) : null}
      </Box>
      {children}
    </Box>
  );
}

/** A compact select for the right-hand side of a setting row; the row is its label. */
export function RowSelect<T extends string | number>({
  id,
  label,
  value,
  onChange,
  width = 220,
  disabled,
  options,
}: {
  id: string;
  /** The accessible name; the row shows its own label. */
  label: string;
  value: T;
  onChange: (value: T) => void;
  width?: number;
  disabled?: boolean;
  options: ReadonlyArray<readonly [T, React.ReactNode]>;
}) {
  return (
    <FormControl size="small" sx={{ width, maxWidth: '100%' }} disabled={disabled}>
      <Select
        id={id}
        value={value}
        // An empty value is a real choice here (e.g. "Automatic shell"), not a placeholder.
        displayEmpty
        inputProps={{ 'aria-label': label }}
        onChange={(event) => onChange(event.target.value as T)}
        MenuProps={{ slotProps: { paper: { sx: { maxWidth: 440 } } } }}
      >
        {options.map(([optionValue, text]) => (
          <MenuItem key={String(optionValue)} value={optionValue}>
            {text}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

export type StatusTone = 'success' | 'info' | 'warning' | 'error';

const STATUS_ICONS = {
  success: CheckCircleOutlineIcon,
  info: InfoOutlinedIcon,
  warning: WarningAmberOutlinedIcon,
  error: ErrorOutlineIcon,
} as const;

/** A row description that reports a state: tinted text behind a status icon. */
export function StatusText({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  const Icon = STATUS_ICONS[tone];
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'flex-start',
        gap: 0.5,
        color: statusTextColor(tone),
        fontWeight: 500,
      }}
    >
      <Icon sx={{ fontSize: 15, mt: '1px', flexShrink: 0 }} />
      <span>{children}</span>
    </Box>
  );
}
