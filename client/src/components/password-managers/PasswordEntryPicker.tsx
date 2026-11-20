import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import {
  PASSWORD_MANAGER_LABELS,
  type ExternalPasswordRef,
  type PasswordManagerEntry,
  type PasswordManagerSource,
} from '@muxus/shared';
import {
  usePasswordManagerEntries,
  usePasswordManagers,
  useSyncPasswordManagerEntries,
} from '../../api/password-managers.js';
import { PasswordManagerDialog } from './PasswordManagerDialog.js';
import { PasswordManagerUnlockForm, unlocksInMuxus } from './PasswordManagerUnlockForm.js';
import { useFocusOnMount } from './useFocusOnMount.js';

/** Rows drawn at once; a longer result asks for a narrower search instead. */
const MAX_ROWS = 150;

/**
 * Choose one entry from a connected password manager. Only titles, user
 * names and addresses are shown; the password stays in the manager and is
 * read by the backend when a login needs it.
 */
export function PasswordEntryPicker({
  value,
  suggestion,
  onPick,
  onClose,
}: {
  /** The entry linked now, to start in its password manager. */
  value?: ExternalPasswordRef;
  /** What the entry is for (a host name or address), offered as the first search. */
  suggestion?: string;
  onPick: (ref: ExternalPasswordRef) => void;
  onClose: () => void;
}) {
  const managers = usePasswordManagers();
  const sources = managers.data?.sources ?? [];
  const [chosen, setChosen] = useState<string | undefined>(value?.sourceId);
  const [query, setQuery] = useState('');
  const [connecting, setConnecting] = useState(false);
  const source = sources.find((candidate) => candidate.id === chosen) ?? sources[0];
  const ready = source?.state === 'ready';
  const entries = usePasswordManagerEntries(source?.id, ready);
  const sync = useSyncPasswordManagerEntries();
  const searchRef = useFocusOnMount(ready);

  // Reading can fail because the manager locked itself meanwhile; the state
  // shown above the list has to say so.
  const refetchManagers = managers.refetch;
  useEffect(() => {
    if (entries.isError) void refetchManagers();
  }, [entries.isError, refetchManagers]);

  const matches = useMemo(
    () => filterEntries(entries.data?.entries ?? [], query),
    [entries.data, query],
  );
  const suggested = suggestion?.trim();
  const offerSuggestion =
    !!suggested && !query && filterEntries(entries.data?.entries ?? [], suggested).length > 0;

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.75 }}>Choose a password-manager entry</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
        <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
          Muxus remembers which entry to use, not the password. It is read from the password
          manager each time you connect.
        </Typography>

        {managers.isLoading ? (
          <Centered>
            <CircularProgress size={22} />
          </Centered>
        ) : sources.length === 0 ? (
          <Centered>
            <Typography variant="body2" color="textSecondary" sx={{ mb: 1.5, textAlign: 'center' }}>
              No password manager is connected yet.
            </Typography>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setConnecting(true)}>
              Connect a password manager
            </Button>
          </Centered>
        ) : (
          <>
            <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
              <TextField
                select
                size="small"
                label="Password manager"
                value={source?.id ?? ''}
                onChange={(event) => {
                  setChosen(event.target.value);
                  setQuery('');
                }}
                fullWidth
              >
                {sources.map((candidate) => (
                  <MenuItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                    <Box component="span" sx={{ ml: 1.5, color: 'text.secondary', fontSize: 13 }}>
                      {stateLabel(candidate)}
                    </Box>
                  </MenuItem>
                ))}
              </TextField>
              <Tooltip title="Connect another password manager">
                <IconButton aria-label="Connect another password manager" onClick={() => setConnecting(true)}>
                  <AddIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>

            {source && !ready ? (
              source.state === 'locked' && unlocksInMuxus(source) ? (
                <PasswordManagerUnlockForm key={source.id} source={source} />
              ) : (
                <Alert
                  severity={source.state === 'unavailable' ? 'error' : 'warning'}
                  variant="outlined"
                  action={
                    <Button color="inherit" size="small" onClick={() => void managers.refetch()}>
                      Check again
                    </Button>
                  }
                >
                  {source.message ?? `${source.name} is not available.`}
                </Alert>
              )
            ) : null}

            {source && ready ? (
              <>
                <TextField
                  size="small"
                  placeholder={`Search ${PASSWORD_MANAGER_LABELS[source.kind]} entries`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  inputRef={searchRef}
                  fullWidth
                  slotProps={{
                    htmlInput: { 'aria-label': 'Search entries' },
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon fontSize="small" />
                        </InputAdornment>
                      ),
                      endAdornment: (
                        <InputAdornment position="end">
                          <Tooltip title="Read the entries again">
                            <span>
                              <IconButton
                                size="small"
                                aria-label="Read the entries again"
                                disabled={sync.isPending || entries.isFetching}
                                onClick={() => sync.mutate(source.id)}
                              >
                                {sync.isPending || entries.isFetching ? (
                                  <CircularProgress size={16} />
                                ) : (
                                  <RefreshIcon fontSize="small" />
                                )}
                              </IconButton>
                            </span>
                          </Tooltip>
                        </InputAdornment>
                      ),
                    },
                  }}
                />
                {offerSuggestion ? (
                  <Box sx={{ mt: 0.75 }}>
                    <Button size="small" onClick={() => setQuery(suggested!)}>
                      Show entries matching “{suggested}”
                    </Button>
                  </Box>
                ) : null}

                {entries.isError || sync.isError ? (
                  <Alert severity="error" variant="outlined" sx={{ mt: 1.5 }}>
                    {errorText(sync.isError ? sync.error : entries.error)}
                  </Alert>
                ) : entries.isLoading ? (
                  <Centered>
                    <CircularProgress size={22} />
                    <Typography variant="caption" color="textSecondary" sx={{ mt: 1.5 }}>
                      Reading entries from {source.name}…
                    </Typography>
                  </Centered>
                ) : matches.length === 0 ? (
                  <Centered>
                    <Typography variant="body2" color="textSecondary">
                      {query ? 'No entry matches.' : 'This password manager has no entries with a password.'}
                    </Typography>
                  </Centered>
                ) : (
                  <List
                    dense
                    aria-label="Entries"
                    sx={{
                      mt: 1,
                      flex: 1,
                      minHeight: 0,
                      maxHeight: 360,
                      overflowY: 'auto',
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1.5,
                      py: 0,
                    }}
                  >
                    {matches.slice(0, MAX_ROWS).map((entry) => (
                      <ListItemButton
                        key={entry.id}
                        selected={value?.sourceId === source.id && value.entryId === entry.id}
                        onClick={() => {
                          onPick({
                            sourceId: source.id,
                            entryId: entry.id,
                            title: entry.title,
                            ...(entry.username ? { username: entry.username } : {}),
                          });
                          onClose();
                        }}
                        sx={{ gap: 1.25, '& + &': { borderTop: 1, borderColor: 'divider' } }}
                      >
                        <KeyOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body2" noWrap title={entry.title}>
                            {entry.title}
                          </Typography>
                          {entry.username || entry.url ? (
                            <Typography variant="caption" color="textSecondary" component="div" noWrap>
                              {[entry.username, entry.url].filter(Boolean).join(' · ')}
                            </Typography>
                          ) : null}
                        </Box>
                        {entry.group ? (
                          <Typography
                            variant="caption"
                            color="textSecondary"
                            noWrap
                            sx={{ flexShrink: 0, maxWidth: '40%' }}
                            title={entry.group}
                          >
                            {entry.group}
                          </Typography>
                        ) : null}
                      </ListItemButton>
                    ))}
                  </List>
                )}
                {matches.length > MAX_ROWS ? (
                  <Typography variant="caption" color="textSecondary" sx={{ mt: 0.75 }}>
                    Showing {MAX_ROWS} of {matches.length} entries. Search to narrow them down.
                  </Typography>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
      {connecting ? (
        <PasswordManagerDialog
          installed={managers.data?.installed ?? []}
          onClose={() => setConnecting(false)}
          onSaved={(saved) => setChosen(saved.id)}
        />
      ) : null}
    </Dialog>
  );
}

/** Entries whose title, user name, address or group holds every search word. */
export function filterEntries(
  entries: readonly PasswordManagerEntry[],
  query: string,
): PasswordManagerEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const text = [entry.title, entry.username, entry.url, entry.group]
      .filter(Boolean)
      .join('\n')
      .toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

function stateLabel(source: PasswordManagerSource): string {
  switch (source.state) {
    case 'ready':
      return '';
    case 'locked':
      return 'Locked';
    case 'signed-out':
      return 'Not signed in';
    default:
      return 'Unavailable';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The entries could not be read.';
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        py: 4,
      }}
    >
      {children}
    </Box>
  );
}
