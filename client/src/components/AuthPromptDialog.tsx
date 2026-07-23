import { useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

export interface AuthPromptRequest {
  name?: string;
  instructions?: string;
  prompts: Array<{ prompt: string; echo: boolean }>;
}

/** Interactive SSH auth: passwords, key passphrases, 2FA codes. */
export function AuthPromptDialog({ request, onSubmit }: { request: AuthPromptRequest | null; onSubmit: (answers: string[] | null) => void }) {
  const [answers, setAnswers] = useState<string[]>([]);
  useEffect(() => {
    setAnswers(request ? request.prompts.map(() => '') : []);
  }, [request]);

  if (!request) return null;
  const submit = () => onSubmit(answers);
  return (
    <Dialog open onClose={() => onSubmit(null)} maxWidth="xs" fullWidth>
      <DialogTitle>{request.name || 'Authentication'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          {request.instructions && (
            <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
              {request.instructions}
            </Typography>
          )}
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
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onSubmit(null)}>Cancel</Button>
        <Button variant="contained" onClick={submit}>
          Continue
        </Button>
      </DialogActions>
    </Dialog>
  );
}
