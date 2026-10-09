import { useState } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import ListItemIcon from '@mui/material/ListItemIcon';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import type { SxProps, Theme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import { useQueryClient } from '@tanstack/react-query';
import { usePasswordVaultStatus } from '../api/password-vault-queries.js';
import { useUiStore } from '../state/ui.js';
import { vaultSecretMissing } from '../vault-secrets.js';
import { VaultSecretDialog } from './VaultSecretDialog.js';

const NEW_SECRET = '\u0000new-secret';
const MISSING_SECRET = '\u0000missing-secret';

/**
 * Pick a named secret from the password vault, or add one on the spot. Only
 * the secret's id is handed out; a reference whose secret was deleted shows
 * as missing until another is picked. Meant for any editor that stores a
 * secret reference: command buttons, host login steps.
 */
export function VaultSecretField({
  value,
  onChange,
  label = 'Secret',
  helperText,
  disabled = false,
  fullWidth = true,
  sx,
}: {
  value: string | undefined;
  onChange: (secretId: string) => void;
  label?: string;
  helperText?: React.ReactNode;
  disabled?: boolean;
  fullWidth?: boolean;
  sx?: SxProps<Theme>;
}) {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = usePasswordVaultStatus();
  const openSettings = useUiStore((state) => state.openSettings);
  const [adding, setAdding] = useState(false);
  const secrets = status?.secrets ?? [];
  const missing = !!value && vaultSecretMissing(status, value) === true;
  const configured = status?.configured ?? true;

  const hint = !configured ? (
    <>
      Secrets live in the password vault.{' '}
      <Link
        component="button"
        type="button"
        variant="caption"
        onClick={() => openSettings({ section: 'passwords' })}
        sx={{ verticalAlign: 'baseline' }}
      >
        Create it under Settings → Passwords
      </Link>
      .
    </>
  ) : missing ? (
    'This secret was deleted from the vault. Pick another one.'
  ) : (
    helperText
  );

  return (
    <>
      <TextField
        select
        label={label}
        fullWidth={fullWidth}
        disabled={disabled || isLoading || !configured}
        error={missing}
        helperText={hint}
        value={missing ? MISSING_SECRET : (value ?? '')}
        onChange={(event) => {
          const next = event.target.value;
          if (next === NEW_SECRET) setAdding(true);
          else if (next !== MISSING_SECRET) onChange(next);
        }}
        slotProps={{
          // The empty value shows a placeholder, so the label always sits on the outline.
          inputLabel: { shrink: true },
          select: {
            displayEmpty: true,
            renderValue: (selected) => {
              if (selected === MISSING_SECRET) return 'Missing secret';
              const secret = secrets.find((candidate) => candidate.id === selected);
              if (!secret) {
                return (
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    Choose a secret
                  </Box>
                );
              }
              return secret.username ? `${secret.name} · ${secret.username}` : secret.name;
            },
          },
        }}
        sx={sx}
      >
        {missing ? (
          <MenuItem value={MISSING_SECRET} disabled>
            Missing secret
          </MenuItem>
        ) : null}
        {secrets.map((secret) => (
          <MenuItem key={secret.id} value={secret.id}>
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {secret.name}
            </Box>
            {secret.username ? (
              <Box component="span" sx={{ ml: 1.5, color: 'text.secondary', fontSize: 13 }}>
                {secret.username}
              </Box>
            ) : null}
          </MenuItem>
        ))}
        <MenuItem value={NEW_SECRET}>
          <ListItemIcon>
            <AddIcon fontSize="small" />
          </ListItemIcon>
          New secret…
        </MenuItem>
      </TextField>
      {adding ? (
        <VaultSecretDialog
          onClose={() => setAdding(false)}
          onSaved={(result) => {
            queryClient.setQueryData(['password-vault'], result.status);
            setAdding(false);
            onChange(result.secret.id);
          }}
        />
      ) : null}
    </>
  );
}
