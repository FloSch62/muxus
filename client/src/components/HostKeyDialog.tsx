import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export interface HostKeyRequest {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  state: 'new' | 'mismatch';
  previous?: string;
}

const mono = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12, overflowWrap: 'anywhere' } as const;

/** Trust-on-first-use host key confirmation; a changed key gets the scary path. */
export function HostKeyDialog({ request, onAnswer }: { request: HostKeyRequest | null; onAnswer: (accept: boolean) => void }) {
  if (!request) return null;
  const mismatch = request.state === 'mismatch';
  return (
    <Dialog open onClose={() => onAnswer(false)} maxWidth="sm" fullWidth>
      <DialogTitle>{mismatch ? 'Host key changed!' : 'Unknown host'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          {mismatch ? (
            <Alert severity="error">
              The identity of {request.host}:{request.port} has CHANGED. This can mean the server was reinstalled — or that the
              connection is being intercepted. Only continue if you can explain the change.
            </Alert>
          ) : (
            <Typography variant="body2">
              First connection to {request.host}:{request.port}. Verify the fingerprint before trusting it.
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {request.keyType} key fingerprint:
          </Typography>
          <Typography sx={mono}>{request.fingerprint}</Typography>
          {request.previous && (
            <>
              <Typography variant="body2" color="text.secondary">
                Previously recorded fingerprint:
              </Typography>
              <Typography sx={mono}>{request.previous}</Typography>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onAnswer(false)}>Cancel</Button>
        <Button variant="contained" color={mismatch ? 'error' : 'primary'} onClick={() => onAnswer(true)}>
          {mismatch ? 'Accept new key' : 'Trust host'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
