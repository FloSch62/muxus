import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import SaveAltOutlinedIcon from '@mui/icons-material/SaveAltOutlined';
import { useFolderSettings } from '../api/folder-settings.js';
import { sharedHostCount } from '../api/shared-sessions.js';
import { folderLabel } from '../host-tree.js';
import { saveTextFile } from '../save-file.js';
import { shareFolder, sharedSessionsFilename } from '../shared-sessions-export.js';
import { useAllManagedHosts } from './sidebar/useAllManagedHosts.js';

const STEPS = [
  'Put the file on a web server, in a Git repository or on a shared drive.',
  'Others choose + → Shared sessions link… and enter its address or path.',
  'To update the list, share again and replace the file.',
];

/**
 * Write a sidebar folder as a session list that others follow. Muxus only
 * writes the file: where it is published is up to the user, so the dialog
 * says what to do with it.
 */
export function ShareFolderDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const hosts = useAllManagedHosts();
  const { data: folderSettings } = useFolderSettings();
  const [includeUsers, setIncludeUsers] = useState(true);
  const [includeKeyPaths, setIncludeKeyPaths] = useState(false);
  const [saved, setSaved] = useState<string | undefined>();
  const label = folderLabel(path);
  const shared = useMemo(
    () => shareFolder(path, hosts, folderSettings?.folders ?? [], { includeUsers, includeKeyPaths }),
    [path, hosts, folderSettings, includeUsers, includeKeyPaths],
  );
  const filename = sharedSessionsFilename(path);

  const save = () => {
    saveTextFile(filename, `${JSON.stringify(shared.document, null, 2)}\n`, 'application/json');
    setSaved(filename);
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.75 }}>Share “{label}”</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="body2" color="textSecondary">
            Saves {sharedHostCount(shared.hostCount)}
            {shared.jumpHostCount > 0
              ? `, and ${shared.jumpHostCount === 1 ? 'the jump host' : `the ${shared.jumpHostCount} jump hosts`} they connect through,`
              : ''}{' '}
            as a list others can follow. No passwords or private keys.
          </Typography>
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={includeUsers}
                  onChange={(event) => setIncludeUsers(event.target.checked)}
                />
              }
              label={<Typography variant="body2">Include user names</Typography>}
              sx={{ display: 'flex' }}
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={includeKeyPaths}
                  onChange={(event) => setIncludeKeyPaths(event.target.checked)}
                />
              }
              label={<Typography variant="body2">Include key file paths</Typography>}
              sx={{ display: 'flex' }}
            />
          </Box>
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 650 }}>
              Next
            </Typography>
            <Box component="ol" sx={{ m: 0, mt: 0.5, pl: 2.5, color: 'text.secondary' }}>
              {STEPS.map((step) => (
                <Typography key={step} component="li" variant="body2" sx={{ mt: 0.5 }}>
                  {step}
                </Typography>
              ))}
            </Box>
          </Box>
          {saved ? (
            <Alert severity="success" variant="outlined">
              Saved {saved}.
            </Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>{saved ? 'Done' : 'Cancel'}</Button>
        <Button
          variant={saved ? 'outlined' : 'contained'}
          startIcon={<SaveAltOutlinedIcon />}
          disabled={shared.hostCount === 0}
          onClick={save}
        >
          {saved ? 'Save again' : 'Save list…'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
