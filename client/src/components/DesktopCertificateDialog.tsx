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
 * Trust-on-first-use for an RDP server's TLS certificate or a VNC server's
 * RSA-AES key, mirroring the SSH host-key dialog: one that changed gets the
 * warning path.
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
  const key = request.kind === 'rsa-key';
  const noun = key ? 'server key' : 'certificate';
  const Noun = key ? 'Server key' : 'Certificate';
  return (
    <Dialog open onClose={() => onAnswer(false)} maxWidth="sm" fullWidth>
      <DialogTitle>{mismatch ? `${Noun} changed!` : key ? 'Unknown server key' : 'Unverified certificate'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          {mismatch ? (
            <Alert severity="error">
              The {noun} of {request.host}:{request.port} has CHANGED since you last trusted it. This can mean the
              server was reinstalled or its {noun} renewed — or that the connection is being intercepted. Only continue
              if you can explain the change.
            </Alert>
          ) : key ? (
            <Typography variant="body2">
              {request.host}:{request.port} identified itself with an RSA key Muxus has not seen before. Before sending
              it your password, compare the signature with the server&apos;s (TigerVNC&apos;s viewer calls it the
              fingerprint).
            </Typography>
          ) : (
            <Typography variant="body2">
              {request.host}:{request.port} presented a certificate Muxus cannot verify
              {request.verificationError ? ` (${request.verificationError})` : ''}. Remote Desktop servers usually use
              self-signed certificates; compare the fingerprint with the server before trusting it.
            </Typography>
          )}
          {request.kind === 'rsa-key' ? (
            <>
              <Field label="Key" value={`RSA, ${request.bits} bits`} />
              <Field label="Signature" value={request.signature} monospace />
            </>
          ) : (
            <>
              <Field label="Issued to" value={request.subject} />
              <Field label="Issued by" value={request.issuer} />
              <Field label="Valid" value={`${request.validFrom} – ${request.validTo}`} />
            </>
          )}
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
          {mismatch ? `Trust new ${noun}` : `Trust ${noun}`}
        </Button>
        {/* oxlint-enable jsx-a11y/no-autofocus */}
      </DialogActions>
    </Dialog>
  );
}
