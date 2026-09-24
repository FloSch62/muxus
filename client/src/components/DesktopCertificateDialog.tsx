import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { DesktopCertificateChallenge } from '@muxus/shared';

const mono = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12, overflowWrap: 'anywhere' } as const;

function Field({ label, value, monospace }: { label: string; value: string; monospace?: boolean }) {
  return (
    <Stack spacing={0.25}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={monospace ? mono : { overflowWrap: 'anywhere' }}>
        {value || '—'}
      </Typography>
    </Stack>
  );
}

/**
 * Trust-on-first-use for an RDP server's TLS certificate, mirroring the SSH
 * host-key dialog: a certificate that changed gets the warning path.
 */
export function DesktopCertificateDialog({
  request,
  onAnswer,
}: {
  request: DesktopCertificateChallenge | null;
  onAnswer: (accept: boolean) => void;
}) {
  if (!request) return null;
  const mismatch = request.state === 'mismatch';
  return (
    <Dialog open onClose={() => onAnswer(false)} maxWidth="sm" fullWidth>
      <DialogTitle>{mismatch ? 'Certificate changed!' : 'Unverified certificate'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          {mismatch ? (
            <Alert severity="error">
              The certificate of {request.host}:{request.port} has CHANGED since you last trusted it. This can mean the
              server was reinstalled or its certificate renewed — or that the connection is being intercepted. Only
              continue if you can explain the change.
            </Alert>
          ) : (
            <Typography variant="body2">
              {request.host}:{request.port} presented a certificate Muxus cannot verify
              {request.verificationError ? ` (${request.verificationError})` : ''}. Remote Desktop servers usually use
              self-signed certificates; compare the fingerprint with the server before trusting it.
            </Typography>
          )}
          <Field label="Issued to" value={request.subject} />
          <Field label="Issued by" value={request.issuer} />
          <Field label="Valid" value={`${request.validFrom} – ${request.validTo}`} />
          <Field label="SHA-256 fingerprint" value={request.fingerprint} monospace />
          {request.previous && <Field label="Previously trusted fingerprint" value={request.previous} monospace />}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onAnswer(false)}>Cancel</Button>
        {/* oxlint-disable jsx-a11y/no-autofocus -- First-contact confirmation is intentionally keyboard-defaulted. */}
        <Button
          variant="contained"
          color={mismatch ? 'error' : 'primary'}
          autoFocus={!mismatch}
          onClick={() => onAnswer(true)}
        >
          {mismatch ? 'Trust new certificate' : 'Trust certificate'}
        </Button>
        {/* oxlint-enable jsx-a11y/no-autofocus */}
      </DialogActions>
    </Dialog>
  );
}
