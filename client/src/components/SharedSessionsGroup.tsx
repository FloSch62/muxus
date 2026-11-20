import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { SharedSessionSource } from '@muxus/shared';
import {
  confirmRemoveSharedSessions,
  refreshSharedSessionsNow,
  sharedHostCount,
  sharedSessionsOrigin,
  sharedSessionsState,
  useDeleteSharedSessionSource,
  useSharedSessionSources,
  useSharedSessionsBeingRead,
} from '../api/shared-sessions.js';
import { SettingsGroup, StatusText } from './SettingsLayout.js';
import { SHARED_SESSIONS_REFRESH_CHOICES, SharedSessionsDialog } from './SharedSessionsDialog.js';

/**
 * Settings → Backup & data: every session list Muxus follows. The same
 * actions sit on each link's folder in the sidebar; this is the overview.
 */
export function SharedSessionsGroup() {
  const queryClient = useQueryClient();
  const sources = useSharedSessionSources();
  const remove = useDeleteSharedSessionSource();
  const reading = useSharedSessionsBeingRead();
  const [editing, setEditing] = useState<{ source?: SharedSessionSource } | undefined>();
  const list = sources.data?.sources ?? [];

  const stopFollowing = async (source: SharedSessionSource) => {
    const answer = await confirmRemoveSharedSessions(source);
    if (answer) remove.mutate({ id: source.id, keepHosts: answer.keepHosts });
  };

  return (
    <>
      <SettingsGroup
        title={list.length ? `Shared sessions · ${list.length}` : 'Shared sessions'}
        description="Host lists you follow from a link or a shared drive. To publish one, right-click a folder in the sidebar and choose Share folder."
        action={
          <Button size="small" startIcon={<AddIcon />} onClick={() => setEditing({})}>
            Add link
          </Button>
        }
        flush
      >
        {list.length === 0 ? (
          <Typography variant="body2" color="textSecondary" sx={{ px: 2, py: 2.5, textAlign: 'center' }}>
            {sources.isLoading ? 'Loading…' : 'No links yet.'}
          </Typography>
        ) : (
          list.map((source) => {
            const busy = reading.has(source.id);
            const state = busy
              ? { tone: 'info' as const, text: 'Reading the list…' }
              : sharedSessionsState(source);
            return (
              <Box
                key={source.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  px: 2,
                  py: 1.1,
                  '& + &': { borderTop: 1, borderColor: 'divider' },
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap sx={{ fontWeight: 550 }} title={source.name}>
                    {source.name}
                  </Typography>
                  <Typography variant="caption" color="textSecondary" component="div" noWrap>
                    {[
                      sharedSessionsOrigin(source.url),
                      `${sharedHostCount(source.hostCount)} in “${source.folder}”`,
                      `checked ${refreshChoice(source.refreshMinutes)}`,
                    ].join(' · ')}
                  </Typography>
                  <Typography variant="caption" component="div" sx={{ mt: 0.25 }}>
                    <StatusText tone={state.tone}>{state.text}</StatusText>
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0, alignItems: 'center' }}>
                  <Tooltip title="Refresh now">
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`Refresh ${source.name}`}
                        disabled={busy}
                        onClick={() => void refreshSharedSessionsNow(queryClient, source)}
                      >
                        {busy ? <CircularProgress size={16} /> : <RefreshIcon sx={{ fontSize: 18 }} />}
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${source.name}`} onClick={() => setEditing({ source })}>
                      <EditOutlinedIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Stop following">
                    <IconButton
                      size="small"
                      aria-label={`Stop following ${source.name}`}
                      onClick={() => void stopFollowing(source)}
                    >
                      <DeleteOutlineIcon color="error" sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Box>
            );
          })
        )}
      </SettingsGroup>

      {editing ? (
        <SharedSessionsDialog
          source={editing.source}
          onClose={() => setEditing(undefined)}
          onSaved={(source) => {
            setEditing(undefined);
            void refreshSharedSessionsNow(queryClient, source);
          }}
        />
      ) : null}
    </>
  );
}

function refreshChoice(minutes: number): string {
  return (
    SHARED_SESSIONS_REFRESH_CHOICES.find((choice) => choice.minutes === minutes)?.short ??
    `every ${minutes} minutes`
  );
}
