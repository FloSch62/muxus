import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import type { SharedSessionSource } from '@muxus/shared';
import { useSaveSharedSessionSource } from '../api/shared-sessions.js';
import { FolderPathField } from './FolderPathField.js';

export const SHARED_SESSIONS_REFRESH_CHOICES = [
  { minutes: 15, label: 'Every 15 minutes', short: 'every 15 minutes' },
  { minutes: 60, label: 'Every hour', short: 'every hour' },
  { minutes: 24 * 60, label: 'Every day', short: 'every day' },
  { minutes: 0, label: 'Only when I refresh it', short: 'on request' },
] as const;
const DEFAULT_REFRESH_MINUTES = 60;

/** Follow a new shared sessions link, or change one. */
export function SharedSessionsDialog({
  source,
  onClose,
  onSaved,
}: {
  source?: SharedSessionSource;
  onClose: () => void;
  onSaved: (source: SharedSessionSource) => void;
}) {
  const [url, setUrl] = useState(source?.url ?? '');
  const [name, setName] = useState(source?.name ?? '');
  // Follows the name until the user picks a folder of their own.
  const [folder, setFolder] = useState<string | undefined>(source?.folder);
  const [refreshMinutes, setRefreshMinutes] = useState(source?.refreshMinutes ?? DEFAULT_REFRESH_MINUTES);
  const save = useSaveSharedSessionSource(onSaved);
  // Only the desktop app can show a file picker that gives a real path.
  const desktop = window.muxusDesktop;
  const selectFile =
    typeof desktop?.selectSharedSessionsFile === 'function'
      ? () => desktop.selectSharedSessionsFile?.()
      : undefined;
  const effectiveFolder = folder ?? name.trim();
  const ready = url.trim().length > 0 && name.trim().length > 0 && effectiveFolder.trim().length > 0;

  const submit = () => {
    if (!ready || save.isPending) return;
    save.mutate({
      ...(source ? { id: source.id } : {}),
      name: name.trim(),
      url: url.trim(),
      folder: effectiveFolder,
      refreshMinutes,
    });
  };

  return (
    <Dialog open onClose={save.isPending ? undefined : onClose} maxWidth="sm" fullWidth>
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DialogTitle sx={{ pb: 0.75 }}>{source ? 'Edit shared sessions' : 'Add shared sessions'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2.25} sx={{ pt: 1 }}>
            <TextField
              label="Link or file"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://portal.example.com/sessions/you.mxtsessions"
              helperText="A web address, or the path of a file such as one on a shared drive."
              fullWidth
              slotProps={{
                htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' },
                input: selectFile
                  ? {
                      endAdornment: (
                        <InputAdornment position="end">
                          <Tooltip title="Browse for a file">
                            <IconButton
                              size="small"
                              aria-label="Browse for a file"
                              onClick={() =>
                                void selectFile()?.then((file) => {
                                  if (file) setUrl(file);
                                })
                              }
                            >
                              <FolderOpenOutlinedIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </InputAdornment>
                      ),
                    }
                  : undefined,
              }}
            />
            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Lab hosts"
              fullWidth
              slotProps={{ htmlInput: { maxLength: 200 } }}
            />
            <FolderPathField
              value={effectiveFolder}
              onChange={setFolder}
              helperText="Use / to nest, e.g. Teams/Lab."
            />
            <TextField
              select
              label="Check for changes"
              value={refreshMinutes}
              onChange={(event) => setRefreshMinutes(Number(event.target.value))}
              fullWidth
            >
              {refreshChoices(refreshMinutes).map((choice) => (
                <MenuItem key={choice.minutes} value={choice.minutes}>
                  {choice.label}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="caption" color="textSecondary">
              Hosts are added, updated and removed with the list. What you set on a host yourself
              stays.
            </Typography>
            {save.isError ? (
              <Alert severity="error" variant="outlined">
                {save.error instanceof Error ? save.error.message : 'Could not save the link.'}
              </Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={!ready || save.isPending}>
            {source ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

/** The usual intervals, plus the link's own when it was set to something else. */
function refreshChoices(minutes: number): ReadonlyArray<{ minutes: number; label: string }> {
  return SHARED_SESSIONS_REFRESH_CHOICES.some((choice) => choice.minutes === minutes)
    ? SHARED_SESSIONS_REFRESH_CHOICES
    : [...SHARED_SESSIONS_REFRESH_CHOICES, { minutes, label: `Every ${minutes} minutes` }];
}

