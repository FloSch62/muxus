import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type {
  AuthPromptInfo,
  AuthPromptResponse,
} from '@muxus/shared';

export type AuthPromptRequest = AuthPromptInfo;
export type AuthPromptResult = AuthPromptResponse;

/** Interactive SSH auth: passwords, key passphrases, 2FA codes. */
export function AuthPromptDialog({
  request,
  onSubmit,
}: {
  request: AuthPromptRequest | null;
  onSubmit: (result: AuthPromptResult | null) => void;
}) {
  const [answers, setAnswers] = useState<string[]>([]);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setAnswers(request ? request.prompts.map(() => '') : []);
    setRememberPassword(false);
    setError(undefined);
  }, [request]);

  if (!request) return null;

  const finish = (result: AuthPromptResult | null) => {
    setAnswers((current) => current.map(() => ''));
    setRememberPassword(false);
    setError(undefined);
    onSubmit(result);
  };

  const submit = () => {
    if (request.purpose === 'vault-create') {
      if (Array.from(answers[0] ?? '').length < 12) {
        setError('Use at least 12 characters for the master password.');
        return;
      }
      if (new TextEncoder().encode(answers[0] ?? '').byteLength > 1024) {
        setError('The master password is too long.');
        return;
      }
      if ((answers[0] ?? '') !== (answers[1] ?? '')) {
        setError('The master-password confirmation does not match.');
        return;
      }
    }
    finish({
      answers: [...answers],
      ...(request.rememberPassword ? { rememberPassword } : {}),
    });
  };

  return (
    <Dialog
      open
      onClose={() =>
        finish(
          request.skipLabel
            ? { answers: [], skipped: true }
            : null,
        )
      }
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>
        {request.name || 'Authentication'}
        {request.host && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {request.host}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          {request.instructions && (
            <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
              {request.instructions}
            </Typography>
          )}
          {error ? <Alert severity="error">{error}</Alert> : null}
          {request.prompts.map((p, i) => (
            <TextField
              key={`${p.prompt}-${i}`}
              label={p.prompt.replace(/:\s*$/, '')}
              type={p.echo ? 'text' : 'password'}
              autoFocus={i === 0}
              value={answers[i] ?? ''}
              onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              fullWidth
              autoComplete="off"
            />
          ))}
          {request.rememberPassword ? (
            <FormControlLabel
              control={
                <Checkbox
                  checked={rememberPassword}
                  onChange={(event) => setRememberPassword(event.target.checked)}
                />
              }
              label={
                <Stack spacing={0}>
                  <Typography variant="body2">
                    {request.rememberPassword.existing
                      ? 'Update the saved password'
                      : 'Remember this password'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Encrypted locally under your password-vault policy.
                  </Typography>
                </Stack>
              }
            />
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        {request.skipLabel ? (
          <Button onClick={() => finish({ answers: [], skipped: true })}>
            {request.skipLabel}
          </Button>
        ) : (
          <Button onClick={() => finish(null)}>Cancel</Button>
        )}
        <Button variant="contained" onClick={submit}>
          {request.purpose === 'vault-create' ? 'Create vault' : 'Continue'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
