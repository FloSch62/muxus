import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AppsOutlinedIcon from '@mui/icons-material/AppsOutlined';
import SearchIcon from '@mui/icons-material/Search';
import type { LocalOpenApplication, LocalOpenTarget } from '@muxus/shared';
import { chooseLocalProgram } from '../local-open.js';
import { showErrorToast } from '../state/toast.js';

const subheaderSx = { lineHeight: '30px', fontSize: 11.5, bgcolor: 'background.paper' } as const;

/**
 * "Open with" on Linux, where the desktop has no chooser Muxus can call:
 * the installed programs, those that handle the file's type first.
 */
export function OpenWithDialog({
  fileName,
  onClose,
  onOpen,
}: {
  fileName: string;
  onClose: () => void;
  onOpen: (target: LocalOpenTarget) => void;
}) {
  const [applications, setApplications] = useState<LocalOpenApplication[]>();
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    let cancelled = false;
    const list = window.muxusDesktop?.listLocalApplications?.(fileName) ?? Promise.resolve(undefined);
    list
      .then((loaded) => {
        if (!cancelled) setApplications(loaded ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setApplications([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Already ordered by the desktop app: default, recommended, then the rest.
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const all = applications ?? [];
    return needle ? all.filter((application) => application.name.toLocaleLowerCase().includes(needle)) : all;
  }, [applications, query]);
  const firstOther = visible.findIndex((application) => !application.recommended);

  useEffect(() => {
    if (selectedId && visible.some((application) => application.id === selectedId)) return;
    setSelectedId(
      query.trim() ? visible[0]?.id : visible.find((application) => application.recommended)?.id,
    );
  }, [query, selectedId, visible]);

  useEffect(() => {
    if (selectedId) itemRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const open = (id = selectedId) => {
    if (id) onOpen({ kind: 'application', id });
  };
  const move = (direction: 1 | -1) => {
    if (visible.length === 0) return;
    const index = visible.findIndex((application) => application.id === selectedId);
    const next = index < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, index + direction));
    setSelectedId(visible[next]!.id);
  };
  const browse = () => {
    chooseLocalProgram()
      .then((program) => {
        if (program) onOpen({ kind: 'application', id: program.id });
      })
      .catch(showErrorToast);
  };

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>Open with</DialogTitle>
      <DialogContent sx={{ pb: 0 }}>
        <Typography
          variant="body2"
          color="textSecondary"
          noWrap
          title={fileName}
          sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 12, mb: 1.25 }}
        >
          {fileName}
        </Typography>
        <TextField
          inputRef={inputRef}
          fullWidth
          size="small"
          placeholder="Search programs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              move(event.key === 'ArrowDown' ? 1 : -1);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              open();
            }
          }}
          slotProps={{
            htmlInput: { 'aria-label': 'Search programs', 'aria-controls': 'open-with-programs' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <Box
          sx={{
            mt: 1,
            height: 340,
            overflowY: 'auto',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
          }}
        >
          {applications === undefined ? (
            <Stack sx={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}>
              <CircularProgress size={22} />
            </Stack>
          ) : visible.length === 0 ? (
            <Stack sx={{ height: '100%', alignItems: 'center', justifyContent: 'center', px: 3 }}>
              <Typography variant="body2" color="textSecondary" sx={{ textAlign: 'center' }}>
                {failed
                  ? 'The installed programs could not be listed. Use Browse… to pick one.'
                  : query.trim()
                    ? `No programs match “${query.trim()}”.`
                    : 'No programs were found. Use Browse… to pick one.'}
              </Typography>
            </Stack>
          ) : (
            <List id="open-with-programs" dense disablePadding aria-label="Programs">
              {visible.map((application, index) => (
                <Fragment key={application.id}>
                  {index === 0 && application.recommended && (
                    <ListSubheader sx={subheaderSx}>Recommended</ListSubheader>
                  )}
                  {index === firstOther && (
                    <ListSubheader sx={subheaderSx}>
                      {firstOther === 0 ? 'Programs' : 'Other programs'}
                    </ListSubheader>
                  )}
                  <ListItemButton
                    ref={(element) => {
                      if (element) itemRefs.current.set(application.id, element);
                      else itemRefs.current.delete(application.id);
                    }}
                    selected={application.id === selectedId}
                    onClick={() => setSelectedId(application.id)}
                    onDoubleClick={() => open(application.id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      open(application.id);
                    }}
                    sx={{ py: 0.4 }}
                  >
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      {application.icon ? (
                        <Box
                          component="img"
                          src={application.icon}
                          alt=""
                          sx={{ width: 24, height: 24, objectFit: 'contain' }}
                        />
                      ) : (
                        <AppsOutlinedIcon sx={{ fontSize: 22, color: 'text.secondary' }} />
                      )}
                    </ListItemIcon>
                    <ListItemText
                      primary={application.name}
                      secondary={application.isDefault ? 'Default' : undefined}
                      slotProps={{
                        primary: { noWrap: true, sx: { fontSize: 13 } },
                        secondary: { sx: { fontSize: 11 } },
                      }}
                    />
                  </ListItemButton>
                </Fragment>
              ))}
            </List>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={browse} sx={{ mr: 'auto' }}>
          Browse…
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!selectedId} onClick={() => open()}>
          Open
        </Button>
      </DialogActions>
    </Dialog>
  );
}
