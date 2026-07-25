import { useEffect, useRef, useState } from 'react';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useDialogStore, type DialogRequest } from '../state/dialogs.js';

/**
 * Renders whatever `confirmAction`/`promptForText` asked for. Mounted once in
 * App, so every confirmation in Muxus has the same anatomy: title, plain-language
 * consequence, Cancel on the left of the committing button.
 */
export function DialogHost() {
  const request = useDialogStore((state) => state.queue[0]);
  const resolveHead = useDialogStore((state) => state.resolveHead);
  // Keyed by request id so each question starts from clean local state.
  return request ? (
    <RequestDialog key={request.id} request={request} onResolve={resolveHead} />
  ) : null;
}

function RequestDialog({
  request,
  onResolve,
}: {
  request: DialogRequest;
  onResolve: (value: boolean | string | null) => void;
}) {
  return request.kind === 'confirm' ? (
    <ConfirmBody request={request} onResolve={onResolve} />
  ) : (
    <PromptBody request={request} onResolve={onResolve} />
  );
}

function ConfirmBody({
  request,
  onResolve,
}: {
  request: Extract<DialogRequest, { kind: 'confirm' }>;
  onResolve: (value: boolean) => void;
}) {
  const [checked, setChecked] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // A confirmation is often reached from the keyboard, so the keyboard has to
  // be able to finish it: Enter commits, Escape keeps things as they are.
  useEffect(() => {
    const frame = requestAnimationFrame(() => confirmRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const confirm = () => {
    if (checked) request.checkbox?.onChecked();
    onResolve(true);
  };

  return (
    <Dialog open onClose={() => onResolve(false)} maxWidth="xs" fullWidth>
      <DialogTitle>{request.title}</DialogTitle>
      {request.description || request.checkbox ? (
        <DialogContent>
          {typeof request.description === 'string' ? (
            <Typography variant="body2" color="text.secondary">
              {request.description}
            </Typography>
          ) : (
            request.description
          )}
          {request.checkbox ? (
            <FormControlLabel
              sx={{ mt: 1 }}
              control={
                <Checkbox
                  size="small"
                  checked={checked}
                  onChange={(event) => setChecked(event.target.checked)}
                />
              }
              label={<Typography variant="body2">{request.checkbox.label}</Typography>}
            />
          ) : null}
        </DialogContent>
      ) : null}
      <DialogActions>
        <Button onClick={() => onResolve(false)}>{request.cancelLabel ?? 'Cancel'}</Button>
        <Button
          ref={confirmRef}
          variant="contained"
          color={request.destructive ? 'error' : 'primary'}
          onClick={confirm}
        >
          {request.confirmLabel ?? 'Confirm'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PromptBody({
  request,
  onResolve,
}: {
  request: Extract<DialogRequest, { kind: 'prompt' }>;
  onResolve: (value: string | null) => void;
}) {
  const [value, setValue] = useState(request.initialValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, []);

  const problem = value.trim() ? (request.validate?.(value.trim()) ?? null) : null;
  const submittable = !!value.trim() && !problem;
  const submit = () => {
    if (submittable) onResolve(value.trim());
  };

  return (
    <Dialog open onClose={() => onResolve(null)} maxWidth="xs" fullWidth>
      <DialogTitle>{request.title}</DialogTitle>
      <DialogContent>
        {request.description ? (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {request.description}
          </Typography>
        ) : null}
        <TextField
          inputRef={inputRef}
          fullWidth
          label={request.label}
          placeholder={request.placeholder}
          value={value}
          error={!!problem}
          helperText={problem ?? ' '}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          sx={{ mt: 0.5 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onResolve(null)}>Cancel</Button>
        <Button variant="contained" disabled={!submittable} onClick={submit}>
          {request.confirmLabel ?? 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
