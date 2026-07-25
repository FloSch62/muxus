import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha, useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveAsOutlinedIcon from '@mui/icons-material/SaveAsOutlined';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import type {
  SftpFileResponse,
  SftpFileSaveResponse,
} from '@muxus/shared';
import { ApiError, apiFetch, apiFetchRaw } from '../api/http.js';
import {
  GENERAL_TEXT_LANGUAGE_ID,
  languageForPath,
} from '../editor/language-detection.js';
import { registerRemoteEditor } from '../editor/remote-editor-registry.js';
import { confirmAction } from '../state/dialogs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { loadMonacoTextEditor } from '../lazy-features.js';
import { FileTypeIcon } from './FileTypeIcon.js';

const MonacoTextEditor = lazy(loadMonacoTextEditor);

interface EditorDocument {
  content: string;
  savedContent: string;
  mtimeMs?: number;
  loading: boolean;
  saving: boolean;
  conflict: boolean;
  error?: string;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** VS Code-like, multi-file Monaco workspace attached to one live SSH session. */
export function RemoteEditorWorkspace({
  tabId,
  connId,
  paths,
  activePath,
  onActivate,
  onClose,
}: {
  tabId: string;
  connId?: string;
  paths: string[];
  activePath?: string;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const theme = useTheme();
  const [documents, setDocuments] = useState<Record<string, EditorDocument>>({});
  const [languageOverrides, setLanguageOverrides] = useState<Record<string, string>>({});

  const load = useCallback(
    async (path: string) => {
      if (!connId) {
        setDocuments((current) => ({
          ...current,
          [path]: {
            content: current[path]?.content ?? '',
            savedContent: current[path]?.savedContent ?? '',
            loading: false,
            saving: false,
            conflict: false,
            error: 'The SSH session is disconnected. Reconnect to load this file.',
          },
        }));
        return;
      }
      setDocuments((current) => ({
        ...current,
        [path]: {
          content: current[path]?.content ?? '',
          savedContent: current[path]?.savedContent ?? '',
          mtimeMs: current[path]?.mtimeMs,
          loading: true,
          saving: false,
          conflict: false,
        },
      }));
      try {
        const file = await apiFetch<SftpFileResponse>(
          `/api/sftp/${connId}/file?path=${encodeURIComponent(path)}`,
        );
        setDocuments((current) => ({
          ...current,
          [path]: {
            content: file.content,
            savedContent: file.content,
            mtimeMs: file.mtimeMs,
            loading: false,
            saving: false,
            conflict: false,
          },
        }));
      } catch (error) {
        setDocuments((current) => ({
          ...current,
          [path]: {
            content: current[path]?.content ?? '',
            savedContent: current[path]?.savedContent ?? '',
            mtimeMs: current[path]?.mtimeMs,
            loading: false,
            saving: false,
            conflict: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [connId],
  );

  // Typing rewrites `documents`; only whether the active file has been opened
  // at all decides whether it still needs loading.
  const activeDocumentOpened = !activePath || documents[activePath] !== undefined;
  useEffect(() => {
    if (activePath && !activeDocumentOpened) void load(activePath);
  }, [activeDocumentOpened, activePath, load]);

  const dirtyPaths = useMemo(
    () => new Set(Object.entries(documents).filter(([, doc]) => doc.content !== doc.savedContent).map(([path]) => path)),
    [documents],
  );
  const dirtyPathsRef = useRef(dirtyPaths);
  dirtyPathsRef.current = dirtyPaths;

  const save = async (path: string, force = false, notify = true): Promise<boolean> => {
    const document = documents[path];
    if (!connId || !document || document.loading || document.saving) return false;
    const contentToSave = document.content;
    setDocuments((current) => ({
      ...current,
      [path]: { ...current[path]!, saving: true, conflict: false },
    }));
    try {
      const result = await apiFetch<SftpFileSaveResponse>(
        `/api/sftp/${connId}/file?path=${encodeURIComponent(path)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: contentToSave,
            expectedMtimeMs: document.mtimeMs,
            force,
          }),
        },
      );
      setDocuments((current) => ({
        ...current,
        [path]: {
          ...current[path]!,
          savedContent: contentToSave,
          mtimeMs: result.mtimeMs,
          saving: false,
          conflict: false,
          error: undefined,
        },
      }));
      if (notify) showToast('success', `Saved ${baseName(path)}`);
      return true;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.body?.code === 'SFTP_FILE_CHANGED'
      ) {
        setDocuments((current) => ({
          ...current,
          [path]: { ...current[path]!, saving: false, conflict: true },
        }));
        return false;
      }
      setDocuments((current) => ({
        ...current,
        [path]: { ...current[path]!, saving: false },
      }));
      showErrorToast(error);
      return false;
    }
  };

  const saveAll = async () => {
    const pathsToSave = [...dirtyPaths].filter((path) => !documents[path]?.saving);
    if (pathsToSave.length === 0) return;
    const results = await Promise.all(pathsToSave.map((path) => save(path, false, false)));
    const saved = results.filter(Boolean).length;
    if (saved > 0) {
      showToast('success', saved === 1 ? `Saved ${baseName(pathsToSave[0]!)}` : `Saved ${saved} files`);
    }
  };

  const close = async (path: string) => {
    if (dirtyPaths.has(path)) {
      const discard = await confirmAction({
        title: `Discard changes to ${baseName(path)}?`,
        description: 'This file has unsaved changes. Closing it now loses those edits.',
        confirmLabel: 'Discard changes',
        destructive: true,
      });
      if (!discard) return;
    }
    setDocuments((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setLanguageOverrides((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    onClose(path);
  };
  const closeActiveRef = useRef<() => void>(() => undefined);
  closeActiveRef.current = () => {
    if (activePath) void close(activePath);
  };

  useEffect(
    () =>
      registerRemoteEditor(tabId, {
        hasDirty: () => dirtyPathsRef.current.size > 0,
        closeActive: () => closeActiveRef.current(),
      }),
    [tabId],
  );

  const document = activePath ? documents[activePath] : undefined;
  const language = activePath
    ? languageOverrides[activePath] ?? languageForPath(activePath, document?.content)
    : 'plaintext';
  const savingCount = Object.values(documents).filter((candidate) => candidate.saving).length;

  const activateRelative = (offset: number) => {
    if (!activePath || paths.length < 2) return;
    const currentIndex = paths.indexOf(activePath);
    const nextIndex = (currentIndex + offset + paths.length) % paths.length;
    onActivate(paths[nextIndex]!);
  };

  return (
    <Box sx={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Stack
        direction="row"
        role="tablist"
        sx={{ height: 36, flexShrink: 0, bgcolor: 'sidebar', borderBottom: 1, borderColor: 'divider', overflowX: 'auto' }}
      >
        {paths.map((path) => {
          const active = path === activePath;
          const dirty = dirtyPaths.has(path);
          return (
            <Stack
              key={path}
              direction="row"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={path}
              onClick={() => onActivate(path)}
              onAuxClick={(event) => {
                if (event.button === 1) void close(path);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onActivate(path);
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  activateRelative(event.key === 'ArrowLeft' ? -1 : 1);
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault();
                  onActivate(paths[event.key === 'Home' ? 0 : paths.length - 1]!);
                }
              }}
              sx={(currentTheme) => ({
                minWidth: 120,
                maxWidth: 220,
                px: 1.25,
                gap: 0.75,
                alignItems: 'center',
                cursor: 'pointer',
                borderRight: 1,
                borderColor: 'divider',
                bgcolor: active ? 'background.default' : 'transparent',
                boxShadow: active ? `inset 0 2px ${currentTheme.palette.primary.main}` : 'none',
              })}
            >
              <FileTypeIcon name={baseName(path)} />
              <Typography variant="body2" noWrap sx={{ flex: 1, fontSize: 12.5 }}>
                {baseName(path)}
              </Typography>
              <IconButton
                size="small"
                aria-label={`Close ${baseName(path)}${dirty ? ', discard unsaved changes' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void close(path);
                }}
                sx={{
                  p: 0.2,
                  width: 18,
                  height: 18,
                  // The dot marks unsaved work at rest and steps aside for the
                  // × on hover, so closing is never a control you cannot see.
                  '&:hover .muxus-dirty-dot': { display: 'none' },
                  '&:hover .muxus-close-glyph': { display: 'block' },
                }}
              >
                {dirty ? (
                  <Box
                    className="muxus-dirty-dot"
                    aria-hidden
                    sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'text.secondary' }}
                  />
                ) : null}
                <CloseIcon
                  className="muxus-close-glyph"
                  sx={{ fontSize: 14, display: dirty ? 'none' : 'block' }}
                />
              </IconButton>
            </Stack>
          );
        })}
      </Stack>
      {activePath && (
        <Stack
          direction="row"
          sx={{ minHeight: 38, px: 1.25, gap: 0.5, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}
        >
          <FileTypeIcon name={baseName(activePath)} />
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            title={activePath}
            sx={{ flex: 1, minWidth: 0, fontFamily: '"JetBrains Mono", monospace' }}
          >
            {activePath}
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ mr: 0.5 }}>
            {language === GENERAL_TEXT_LANGUAGE_ID ? 'General text' : language}
          </Typography>
          <Tooltip title="Reload from remote">
            <span>
              <IconButton
                size="small"
                aria-label="Reload from remote"
                disabled={document?.loading}
                onClick={() => {
                  if (!dirtyPaths.has(activePath)) {
                    void load(activePath);
                    return;
                  }
                  void confirmAction({
                    title: 'Reload from remote?',
                    description: 'Your local changes to this file are discarded.',
                    confirmLabel: 'Discard and reload',
                    destructive: true,
                  }).then((confirmed) => {
                    if (confirmed) void load(activePath);
                  });
                }}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Download">
            <span>
              <IconButton
                size="small"
                aria-label="Download this file"
                disabled={!connId}
                onClick={() => {
                  if (!connId) return;
                  void apiFetchRaw(
                    `/api/sftp/${connId}/download?path=${encodeURIComponent(activePath)}`,
                  )
                    .then((response) => response.blob())
                    .then((blob) => downloadBlob(baseName(activePath), blob))
                    .catch(showErrorToast);
                }}
              >
                <DownloadOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Save (Ctrl/Cmd+S)">
            <span>
              <IconButton
                size="small"
                aria-label="Save this file"
                color={dirtyPaths.has(activePath) ? 'primary' : 'default'}
                disabled={!document || document.loading || document.saving || !connId}
                onClick={() => void save(activePath)}
              >
                {document?.saving ? <CircularProgress size={16} /> : <SaveOutlinedIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Save all (Ctrl/Cmd+K, S)">
            <span>
              <IconButton
                size="small"
                aria-label="Save all files"
                color={dirtyPaths.size > 0 ? 'primary' : 'default'}
                disabled={dirtyPaths.size === 0 || savingCount > 0 || !connId}
                onClick={() => void saveAll()}
              >
                {savingCount > 0 ? <CircularProgress size={16} /> : <SaveAsOutlinedIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" aria-label="Close editor" onClick={() => void close(activePath)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
      )}
      {document?.conflict && activePath && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0, py: 0.25 }}
          action={
            <Stack direction="row" spacing={0.5}>
              <Button
                color="inherit"
                onClick={() => {
                  void confirmAction({
                    title: 'Load the remote version?',
                    description: 'Your local changes to this file are discarded.',
                    confirmLabel: 'Discard and reload',
                    destructive: true,
                  }).then((confirmed) => {
                    if (confirmed) void load(activePath);
                  });
                }}
              >
                Reload remote
              </Button>
              <Button color="warning" variant="contained" onClick={() => void save(activePath, true)}>
                Overwrite remote
              </Button>
            </Stack>
          }
        >
          The remote file changed after you opened it.
        </Alert>
      )}
      {document?.loading && <LinearProgress />}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {document?.error ? (
          <Stack sx={{ height: '100%', alignItems: 'center', justifyContent: 'center', p: 3 }} spacing={1.5}>
            <Typography variant="body2" color="error">
              {document.error}
            </Typography>
            <Button startIcon={<RefreshIcon />} disabled={!connId} onClick={() => activePath && void load(activePath)}>
              Try again
            </Button>
          </Stack>
        ) : document && !document.loading && activePath ? (
          <Suspense fallback={<LinearProgress />}>
            <MonacoTextEditor
              workspaceId={tabId}
              openPaths={paths}
              path={activePath}
              language={language}
              value={document.content}
              dark={theme.palette.mode === 'dark'}
              readOnly={!connId}
              onChange={(content) =>
                setDocuments((current) => ({
                  ...current,
                  [activePath]: { ...current[activePath]!, content, conflict: false },
                }))
              }
              onLanguageChange={(nextLanguage) =>
                setLanguageOverrides((current) => ({
                  ...current,
                  [activePath]: nextLanguage,
                }))
              }
              onSave={() => void save(activePath)}
              onSaveAll={() => void saveAll()}
              onClose={() => void close(activePath)}
              onNextTab={() => activateRelative(1)}
              onPreviousTab={() => activateRelative(-1)}
            />
          </Suspense>
        ) : (
          <Box
            sx={{
              height: '100%',
              display: 'grid',
              placeItems: 'center',
              color: 'text.secondary',
              bgcolor: alpha(theme.palette.background.paper, 0.35),
            }}
          >
            {document?.loading ? <CircularProgress size={22} /> : null}
          </Box>
        )}
      </Box>
    </Box>
  );
}
