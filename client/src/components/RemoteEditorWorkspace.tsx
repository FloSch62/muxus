import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
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
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import type {
  SftpFileResponse,
  SftpFileSaveResponse,
} from '@muxus/shared';
import { ApiError, apiFetch, apiFetchRaw } from '../api/http.js';
import { registerRemoteEditor } from '../editor/remote-editor-registry.js';
import { showErrorToast, showToast } from '../state/toast.js';

const MonacoTextEditor = lazy(() => import('./MonacoTextEditor.js'));

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

function languageForPath(path: string): string {
  const name = baseName(path).toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const exact: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'plaintext',
    '.bashrc': 'shell',
    '.zshrc': 'shell',
    '.profile': 'shell',
  };
  if (exact[name]) return exact[name];
  const languages: Record<string, string> = {
    bash: 'shell',
    c: 'c',
    cc: 'cpp',
    conf: 'ini',
    cpp: 'cpp',
    css: 'css',
    env: 'ini',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    ini: 'ini',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    log: 'plaintext',
    lua: 'lua',
    md: 'markdown',
    php: 'php',
    properties: 'ini',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    toml: 'ini',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'plaintext',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return languages[extension] ?? 'plaintext';
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

  useEffect(() => {
    if (activePath && !documents[activePath]) void load(activePath);
  }, [activePath, documents, load]);

  const dirtyPaths = useMemo(
    () => new Set(Object.entries(documents).filter(([, doc]) => doc.content !== doc.savedContent).map(([path]) => path)),
    [documents],
  );

  useEffect(
    () => registerRemoteEditor(tabId, { hasDirty: () => dirtyPaths.size > 0 }),
    [dirtyPaths, tabId],
  );

  const save = async (path: string, force = false) => {
    const document = documents[path];
    if (!connId || !document || document.loading || document.saving) return;
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
      showToast('success', `Saved ${baseName(path)}`);
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
        return;
      }
      setDocuments((current) => ({
        ...current,
        [path]: { ...current[path]!, saving: false },
      }));
      showErrorToast(error);
    }
  };

  const close = (path: string) => {
    if (
      dirtyPaths.has(path) &&
      !window.confirm(`${baseName(path)} has unsaved changes. Close and discard them?`)
    ) {
      return;
    }
    setDocuments((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    onClose(path);
  };

  const document = activePath ? documents[activePath] : undefined;
  const language = activePath ? languageForPath(activePath) : 'plaintext';

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
              onClick={() => onActivate(path)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onActivate(path);
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
              <Typography variant="body2" noWrap sx={{ flex: 1, fontSize: 12.5 }}>
                {baseName(path)}
              </Typography>
              {dirty ? (
                <Box
                  aria-label="Unsaved changes"
                  sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'text.secondary', flexShrink: 0 }}
                />
              ) : (
                <IconButton
                  size="small"
                  aria-label={`Close ${baseName(path)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    close(path);
                  }}
                  sx={{ p: 0.2 }}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              )}
            </Stack>
          );
        })}
      </Stack>
      {activePath && (
        <Stack
          direction="row"
          sx={{ minHeight: 38, px: 1.25, gap: 0.5, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}
        >
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
            {language}
          </Typography>
          <Tooltip title="Reload from remote">
            <span>
              <IconButton
                size="small"
                disabled={document?.loading}
                onClick={() => {
                  if (!dirtyPaths.has(activePath) || window.confirm('Discard local changes and reload the remote file?')) {
                    void load(activePath);
                  }
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
                color={dirtyPaths.has(activePath) ? 'primary' : 'default'}
                disabled={!document || document.loading || document.saving || !connId}
                onClick={() => void save(activePath)}
              >
                {document?.saving ? <CircularProgress size={16} /> : <SaveOutlinedIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" aria-label="Close editor" onClick={() => close(activePath)}>
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
                  if (window.confirm('Discard your local changes and load the remote version?')) void load(activePath);
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
              onSave={() => void save(activePath)}
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
