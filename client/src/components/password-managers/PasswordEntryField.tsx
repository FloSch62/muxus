import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import type { ExternalPasswordRef } from '@muxus/shared';
import { usePasswordManagers } from '../../api/password-managers.js';
import { PasswordEntryPicker } from './PasswordEntryPicker.js';

/**
 * The password-manager entry a host or folder logs in with: shows the linked
 * entry, opens the picker to choose one, and unlinks it. Holds a reference
 * only, never a password.
 */
export function PasswordEntryField({
  value,
  onChange,
  suggestion,
  helperText,
}: {
  value: ExternalPasswordRef | undefined;
  onChange: (ref: ExternalPasswordRef | undefined) => void;
  /** What the entry is for, offered as a search in the picker. */
  suggestion?: string;
  helperText?: React.ReactNode;
}) {
  const [picking, setPicking] = useState(false);
  const { data } = usePasswordManagers();
  const source = value ? data?.sources.find((candidate) => candidate.id === value.sourceId) : undefined;
  // Known only once the list has loaded: a slow answer is not a missing manager.
  const orphaned = !!value && !!data && !source;

  return (
    <Box>
      {value ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.25,
            pl: 1.5,
            pr: 0.75,
            py: 0.75,
            border: 1,
            borderColor: orphaned ? 'warning.main' : 'divider',
            borderRadius: 1.5,
          }}
        >
          <KeyOutlinedIcon sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" noWrap title={value.title}>
              {value.title || 'Untitled entry'}
              {value.username ? (
                <Box component="span" sx={{ ml: 1, color: 'text.secondary' }}>
                  {value.username}
                </Box>
              ) : null}
            </Typography>
            <Typography
              variant="caption"
              color={orphaned ? 'warning' : 'textSecondary'}
              component="div"
              noWrap
            >
              {orphaned
                ? 'Its password manager is no longer connected.'
                : source
                  ? `Password from ${source.name}`
                  : 'Password from a password manager'}
            </Typography>
          </Box>
          <Button size="small" onClick={() => setPicking(true)}>
            Change
          </Button>
          <Tooltip title="Stop using this entry">
            <IconButton size="small" aria-label="Stop using this entry" onClick={() => onChange(undefined)}>
              <LinkOffOutlinedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Box>
      ) : (
        <Button variant="outlined" startIcon={<KeyOutlinedIcon />} onClick={() => setPicking(true)}>
          Choose from a password manager…
        </Button>
      )}
      {helperText ? (
        <Typography variant="caption" color="textSecondary" component="div" sx={{ mt: 0.75 }}>
          {helperText}
        </Typography>
      ) : null}
      {picking ? (
        <PasswordEntryPicker
          value={value}
          suggestion={suggestion}
          onPick={onChange}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </Box>
  );
}
