import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { HostSessionLoggingDraft } from '../../session-logging-policy.js';
import { SessionLoggingPolicyFields } from '../SessionLoggingPolicyFields.js';

export function LoggingSection({
  value,
  onChange,
}: {
  value: HostSessionLoggingDraft;
  onChange: (patch: Partial<HostSessionLoggingDraft>) => void;
}) {
  return (
    <Stack spacing={2}>
      <div>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Session logging
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Choose whether new sessions for this host inherit the application default or use a
          dedicated retention and input-privacy policy.
        </Typography>
      </div>
      <SessionLoggingPolicyFields
        value={value}
        onChange={onChange}
        allowInherit
      />
      {!value.inherit && value.enabled && value.captureInput ? (
        <Alert severity="warning">
          Input recording can retain commands containing credentials. Output echoed by the remote
          shell may be retained regardless of this switch.
        </Alert>
      ) : null}
    </Stack>
  );
}
