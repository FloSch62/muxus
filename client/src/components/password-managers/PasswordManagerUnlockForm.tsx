import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import type { PasswordManagerSource } from '@muxus/shared';
import { useUnlockPasswordManager } from '../../api/password-managers.js';
import { useFocusOnMount } from './useFocusOnMount.js';

/** Whether Muxus itself can unlock this manager, with the password it asks for. */
export function unlocksInMuxus(source: Pick<PasswordManagerSource, 'kind'>): boolean {
  return source.kind === 'keepass' || source.kind === 'bitwarden';
}

export function unlockPasswordLabel(source: Pick<PasswordManagerSource, 'kind'>): string {
  return source.kind === 'bitwarden' ? 'Bitwarden master password' : 'Database password';
}

/**
 * Unlock a KeePass database or a Bitwarden vault. The password goes to the
 * backend, which keeps the manager unlocked in memory until it is locked or
 * Muxus quits; it is never stored.
 */
export function PasswordManagerUnlockForm({
  source,
  onUnlocked,
  autoFocus = true,
}: {
  source: PasswordManagerSource;
  onUnlocked?: () => void;
  autoFocus?: boolean;
}) {
  const unlock = useUnlockPasswordManager();
  const [password, setPassword] = useState('');
  const focusRef = useFocusOnMount(autoFocus);
  // A database protected by a key file alone has no password to type.
  const optional = source.kind === 'keepass' && !!source.config.keyFile;

  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!password && !optional) return;
        unlock.mutate(
          { id: source.id, password },
          {
            onSuccess: () => {
              setPassword('');
              onUnlocked?.();
            },
          },
        );
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <TextField
          label={unlockPasswordLabel(source)}
          type="password"
          autoComplete="off"
          size="small"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (unlock.isError) unlock.reset();
          }}
          error={unlock.isError}
          helperText={
            unlock.isError
              ? unlock.error instanceof Error
                ? unlock.error.message
                : 'Could not unlock.'
              : `Unlocks ${source.name} until you lock it or quit Muxus.`
          }
          inputRef={focusRef}
          fullWidth
        />
        <Button
          type="submit"
          variant="contained"
          disabled={unlock.isPending || (!password && !optional)}
          sx={{ mt: 0.25, flexShrink: 0 }}
        >
          Unlock
        </Button>
      </Stack>
    </Box>
  );
}
