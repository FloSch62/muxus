import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useFolderSettings } from '../../api/folder-settings.js';
import { inheritedLoginSequence, type LoginSequenceDraft } from '../../login-sequence.js';
import { normalizeGroupPath } from '../../host-tree.js';
import { LoginSequenceEditor } from '../LoginSequenceEditor.js';

/** A host's own login sequence, or the one it takes from its folder. */
export function LoginSequenceSection({
  value,
  onChange,
  group,
}: {
  value: LoginSequenceDraft;
  onChange: (value: LoginSequenceDraft) => void;
  /** The folder the host is in, as the draft has it now. */
  group: string;
}) {
  const { data: settings } = useFolderSettings();
  const inherited = inheritedLoginSequence(settings?.folders, group);

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Login sequence
        </Typography>
        <Typography variant="body2" color="textSecondary">
          Steps that run once the session connects, and again after every reconnect: wait for
          a prompt, then answer it. Secrets are typed from the password vault and never written
          to session history or log files.
        </Typography>
      </Box>
      <LoginSequenceEditor
        value={value}
        onChange={onChange}
        inherited={inherited}
        inheritLabel="Use the folder's login sequence"
        inheritEmptyText={
          normalizeGroupPath(group)
            ? 'No folder this host is in sets a login sequence, so none runs.'
            : 'This host is not in a folder, so no login sequence runs.'
        }
      />
    </Stack>
  );
}
