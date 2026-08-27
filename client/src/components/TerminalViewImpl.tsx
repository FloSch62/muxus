import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import SearchIcon from '@mui/icons-material/Search';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { AppInfo, TerminalServerMessage } from '@muxus/shared';
import {
  apiFetch,
  closeTerminalWebSocket,
  wsProtocols,
  wsUrl,
} from '../api/http.js';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import {
  copyToClipboard,
  readClipboardContent,
} from '../clipboard.js';
import { loadMonacoTextEditor, loadRemoteEditorWorkspace } from '../lazy-features.js';
import { IS_MAC } from '../platform.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { showToast } from '../state/toast.js';
import { broadcastTerminalInput } from '../state/multi-exec.js';
import {
  TERMINAL_SYMBOL_FONT,
  terminalFontStack,
  terminalSchemeIdForMode,
  usePrefsStore,
} from '../state/prefs.js';
import { useTabsStore, type SessionTab } from '../state/tabs.js';
import {
  terminalColorForHost,
  terminalSchemeIdForHost,
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  terminalScheme,
  themeWithColorOverrides,
} from '../terminal/palette.js';
import { attachCommandTracker, attachCwdTracker } from '../terminal/shell-integration.js';
import { attachOsc52Clipboard } from '../terminal/osc52-clipboard.js';
import {
  attachKeywordHighlighter,
  resolveKeywordHighlights,
  type KeywordHighlighter,
} from '../terminal/keyword-highlighting.js';
import { registerTerminal } from '../terminal/terminal-registry.js';
import {
  attachTerminalFileLinks,
  resolveTerminalFilePath,
} from '../terminal/file-links.js';
import {
  altClickMovesCursorForFileLinkActivation,
  terminalFileLinkActivationForPlatform,
} from '../terminal/file-link-activation.js';
import { openTerminalWebLink } from '../terminal/web-links.js';
import { requiresPasteConfirmation } from '../terminal/paste-safety.js';
import { shouldFitTerminal } from '../terminal/terminal-fit.js';
import { terminalSelectionText } from '../terminal/selection-text.js';
import { normalizeTerminalKeyboardInput } from '../terminal/keyboard-input.js';
import {
  terminalRightClickIntent,
  xtermRightClickSelectsWord,
} from '../terminal/right-click.js';
import {
  isCurrentTerminalImagePasteTarget,
  pasteTerminalClipboard,
  type TerminalClipboardPayload,
  TerminalClipboardPasteQueue,
  uploadTerminalClipboardImage,
} from '../terminal/clipboard-paste.js';
import {
  AuthPromptDialog,
  type AuthPromptRequest,
  type AuthPromptResult,
} from './AuthPromptDialog.js';
import { HostKeyDialog, type HostKeyRequest } from './HostKeyDialog.js';
import { PasteConfirmDialog } from './PasteConfirmDialog.js';
import {
  AUTO_RECONNECT_DELAYS_MS,
  AUTO_RECONNECT_STABLE_MS,
  autoReconnectDelayMs,
  CONNECTION_INTERRUPTION_GRACE_MS,
  connectionFailureReason,
  reattachCommand,
  rendererReattachDelayMs,
  restoreCwdCommand,
  shouldDelayConnectionLost,
  shouldWaitForTerminalOutput,
  terminalNotice,
  type TerminalExitMessage,
} from '../connection-recovery.js';
import {
  fetchTerminalSnapshot,
  putTerminalSnapshot,
  serializeScrollback,
  snapshotBodyBytes,
  TERMINAL_HISTORY_DIVIDER,
  TERMINAL_SNAPSHOT_INTERVAL_MS,
  TERMINAL_SNAPSHOT_QUIET_MS,
} from '../terminal/scrollback-snapshots.js';
import { registerUnloadKeepalive } from '../unload-keepalive.js';
import { completeTabTransfer } from '../tab-transfer.js';

const SEARCH_DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#594b24',
  matchOverviewRuler: '#d7b84b',
  activeMatchBackground: '#b77b23',
  activeMatchColorOverviewRuler: '#ffb74d',
};

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 40;
/** Type-ahead held for a session that has not finished connecting. */
const PENDING_INPUT_LIMIT = 64 * 1024;
const ACTIVE_IMAGE_STORAGE_MB = 64;
const BACKGROUND_IMAGE_STORAGE_MB = 16;
/** Quiet period a container size has to hold before the terminal refits. */
const RESIZE_SETTLE_MS = 90;
const TRANSFER_PREPARE_TIMEOUT_MS = 5_000;

/** Plain-text contents of scrollback + screen, trailing blank rows trimmed. */
function bufferText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? `${lines.join('\n')}\n` : '';
}

async function openLinkedTerminalFile(tabId: string, candidate: string): Promise<void> {
  let current = useTabsStore.getState().tabs.find((tab) => tab.id === tabId);
  if (!current?.profile) return;

  let path: string | undefined;
  if (current.profile.kind === 'local') {
    path = resolveTerminalFilePath(candidate, current.terminalCwd, undefined, 'local');
    if (!path && candidate.startsWith('~/')) {
      try {
        const info = await apiFetch<AppInfo>('/api/app/info');
        current = useTabsStore.getState().tabs.find((tab) => tab.id === tabId);
        if (current?.profile?.kind !== 'local') return;
        path = resolveTerminalFilePath(candidate, current.terminalCwd, info.homeDir, 'local');
      } catch (error) {
        showToast(
          'warning',
          `Could not resolve the local home directory: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
    }
    if (!path) {
      showToast(
        'warning',
        'The local working directory is unavailable. Click an absolute path instead.',
      );
      return;
    }
  } else if (current.profile.kind === 'ssh') {
    if (current.sftpAvailable === false) {
      showToast('warning', 'SFTP is disabled for this host, so remote files cannot be edited.');
      return;
    }
    const connId = current.connId;
    if (!connId) {
      showToast('warning', 'Reconnect the SSH session before opening a remote file.');
      return;
    }

    path = resolveTerminalFilePath(candidate, current.terminalCwd);
    if (!path && candidate.startsWith('~/')) {
      try {
        const home = await apiFetch<{ path: string }>(`/api/sftp/${connId}/home`);
        current = useTabsStore.getState().tabs.find((tab) => tab.id === tabId);
        if (current?.connId !== connId) return;
        path = resolveTerminalFilePath(candidate, current.terminalCwd, home.path);
      } catch (error) {
        showToast(
          'warning',
          `Could not resolve the remote home directory: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
    }
    if (!path) {
      showToast(
        'warning',
        'The remote working directory is unavailable. Click an absolute path instead.',
      );
      return;
    }
  } else {
    return;
  }

  // Start both lazy chunks together; the editor still stays out of the
  // terminal bundle and is loaded only after an explicit file-open gesture.
  void Promise.all([loadRemoteEditorWorkspace(), loadMonacoTextEditor()]).catch(() => undefined);
  useTabsStore.getState().openEditor(tabId, path);
}

interface PendingPaste {
  text: string;
  broadcast: boolean;
  resolve: () => void;
}

export default function TerminalViewImpl({ tab, active }: { tab: SessionTab; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const terminalInputReadyRef = useRef(false);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const imageRef = useRef<ImageAddon | null>(null);
  const keywordHighlighterRef = useRef<KeywordHighlighter | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** xterm's native default is enabled on macOS and disabled elsewhere. */
  const rightClickSelectsWordDefaultRef = useRef(false);
  const lastSearchRequestRef = useRef(tab.searchRequest);
  /** Per-tab zoom offset added to the preference font size. */
  const zoomRef = useRef(0);
  /** Automatic redials since the last stable connection; survives remounts of the socket. */
  const autoReconnectAttemptsRef = useRef(0);
  /** Serialized buffer carried across socket generations by a reconnect. */
  const carryBufferRef = useRef<string | null>(null);
  /** Stored history is fetched at most once per mounted tab. */
  const snapshotFetchedRef = useRef(false);
  const suppressNextInputBroadcastRef = useRef(false);
  const clipboardPasteQueueRef = useRef<TerminalClipboardPasteQueue | null>(null);
  const clipboardPasteQueue = (clipboardPasteQueueRef.current ??= new TerminalClipboardPasteQueue());
  const pendingPasteResolverRef = useRef<(() => void) | null>(null);
  const theme = useTheme();
  const [authPrompt, setAuthPrompt] = useState<AuthPromptRequest | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyRequest | null>(null);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchWord, setSearchWord] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchResult, setSearchResult] = useState({ resultIndex: -1, resultCount: 0 });
  const [ctxMenu, setCtxMenu] = useState<{
    top: number;
    left: number;
    selection: string;
  } | null>(null);
  useEffect(
    () => () => {
      clipboardPasteQueueRef.current?.cancelAll();
      pendingPasteResolverRef.current?.();
      pendingPasteResolverRef.current = null;
    },
    [],
  );
  const [generation, setGeneration] = useState(tab.connectOnMount ? 1 : 0);
  const reconnectRequest = useTabsStore(
    (s) => s.tabs.find((candidate) => candidate.id === tab.id)?.reconnectRequest ?? 0,
  );
  const lastReconnectRequestRef = useRef(reconnectRequest);
  const updateTab = useTabsStore((s) => s.update);
  const notifyOutput = useTabsStore((s) => s.notifyOutput);
  const searchRequest = useTabsStore(
    (s) => s.tabs.find((candidate) => candidate.id === tab.id)?.searchRequest ?? 0,
  );
  const monoFontSize = usePrefsStore((s) => s.monoFontSize);
  const fontFamily = usePrefsStore((s) => s.fontFamily);
  const lineHeight = usePrefsStore((s) => s.lineHeight);
  const cursorBlink = usePrefsStore((s) => s.cursorBlink);
  const cursorStyle = usePrefsStore((s) => s.cursorStyle);
  const scrollback = usePrefsStore((s) => s.scrollback);
  const applicationSchemeId = usePrefsStore((prefs) =>
    terminalSchemeIdForMode(prefs, theme.palette.mode),
  );
  const fontColor = usePrefsStore((s) => s.fontColor);
  const backgroundColor = usePrefsStore((s) => s.backgroundColor);
  const globalKeywordHighlights = usePrefsStore((s) => s.keywordHighlights);
  const keywordHighlightProfiles = usePrefsStore((s) => s.keywordHighlightProfiles);
  const { data: sshConfig } = useSshConfig(tab.profile.kind === 'ssh' && tab.profile.useConfig !== false);
  const savedProfileId =
    tab.profile.kind === 'ssh' ||
    tab.profile.kind === 'telnet' ||
    tab.profile.kind === 'serial'
      ? tab.profile.profileId
      : undefined;
  const { data: savedHosts } = useSavedHostProfiles(!!savedProfileId);
  const hostMetadata = useMemo(() => {
    if (savedProfileId) {
      return savedHosts?.profiles.find((profile) => profile.id === savedProfileId)
        ?.metadata;
    }
    if (tab.profile.kind !== 'ssh' || tab.profile.useConfig === false) return undefined;
    const target = tab.profile.target;
    return sshConfig?.hosts.find((host) => host.aliases.includes(target))?.metadata;
  }, [sshConfig, savedHosts, savedProfileId, tab.profile]);
  const schemeId = terminalSchemeIdForHost(
    applicationSchemeId,
    hostMetadata?.terminalScheme,
  );
  const scheme = terminalScheme(schemeId);
  const effectiveFontColor = terminalColorForHost(
    fontColor,
    hostMetadata?.terminalFontColor,
  );
  const effectiveBackgroundColor = terminalColorForHost(
    backgroundColor,
    hostMetadata?.terminalBackgroundColor,
  );
  const terminalTheme = useMemo(
    () => themeWithColorOverrides(
      scheme.theme,
      effectiveFontColor,
      effectiveBackgroundColor,
    ),
    [scheme, effectiveFontColor, effectiveBackgroundColor],
  );
  const hostKeywordHighlights = hostMetadata?.keywordHighlights;
  const keywordHighlights = useMemo(
    () =>
      resolveKeywordHighlights(
        globalKeywordHighlights,
        hostKeywordHighlights,
        hostKeywordHighlights?.profileId
          ? keywordHighlightProfiles.find(
              (profile) => profile.id === hostKeywordHighlights.profileId,
            )?.rules
          : undefined,
      ),
    [globalKeywordHighlights, hostKeywordHighlights, keywordHighlightProfiles],
  );

  const searchOptions = useMemo<ISearchOptions>(
    () => ({
      caseSensitive: searchCase,
      wholeWord: searchWord,
      regex: searchRegex,
      decorations: SEARCH_DECORATIONS,
    }),
    [searchCase, searchWord, searchRegex],
  );

  const pasteToTerminal = (text: string, broadcast: boolean) => {
    const term = termRef.current;
    if (!term) return;
    if (!broadcast) suppressNextInputBroadcastRef.current = true;
    term.paste(text);
  };

  const pasteText = (text: string, broadcast = true): Promise<void> => {
    if (usePrefsStore.getState().pasteWarnMultiline && requiresPasteConfirmation(text)) {
      setSearchOpen(false);
      const { promise, resolve } = Promise.withResolvers<void>();
      pendingPasteResolverRef.current = resolve;
      setPendingPaste({ text, broadcast, resolve });
      return promise;
    }
    pasteToTerminal(text, broadcast);
    return Promise.resolve();
  };

  /** Refit, unless the pane is hidden and there is nothing to measure. */
  const fitTerminal = (): boolean => {
    if (!shouldFitTerminal(containerRef.current)) return false;
    fitRef.current?.fit();
    return true;
  };

  const applyZoom = (action: 'in' | 'out' | 'reset') => {
    const base = usePrefsStore.getState().monoFontSize;
    const next =
      action === 'reset'
        ? base
        : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, base + zoomRef.current + (action === 'in' ? 1 : -1)));
    zoomRef.current = next - base;
    const term = termRef.current;
    if (term) {
      term.options.fontSize = next;
      fitTerminal();
    }
  };

  const pasteFromClipboard = (
    capture: (signal: AbortSignal) => Promise<TerminalClipboardPayload> = () =>
      readClipboardContent(),
  ) => {
    const operation = clipboardPasteQueue.enqueue(capture, (clipboard, signal) => {
      let uploadedConnectionId: string | undefined;
      return pasteTerminalClipboard(clipboard, {
        uploadImage: async (png) => {
          const current = useTabsStore
            .getState()
            .tabs.find((candidate) => candidate.id === tab.id);
          if (current?.profile?.kind !== 'ssh') {
            throw new Error('Image paste is available in SSH terminals.');
          }
          if (current.sftpAvailable === false) {
            throw new Error('Image paste requires SFTP, which is disabled for this host.');
          }
          if (!current.connId) {
            throw new Error('Reconnect the SSH session before pasting an image.');
          }
          uploadedConnectionId = current.connId;
          return uploadTerminalClipboardImage(current.connId, png, signal);
        },
        pasteText,
        pasteImagePath: async (path) => {
          signal.throwIfAborted();
          const current = useTabsStore
            .getState()
            .tabs.find((candidate) => candidate.id === tab.id);
          if (
            !isCurrentTerminalImagePasteTarget({
              connectionId: current?.connId,
              expectedConnectionId: uploadedConnectionId,
              inputReady: terminalInputReadyRef.current,
              socketOpen: wsRef.current?.readyState === WebSocket.OPEN,
              ssh: current?.profile?.kind === 'ssh',
            })
          ) {
            throw new Error('The SSH session disconnected before the image path was pasted.');
          }
          await pasteText(path, false);
        },
      });
    });
    void operation
      .then((result) => {
        if (result.status === 'skipped' && result.reason === 'unavailable') {
          showToast(
            'warning',
            'Clipboard read unavailable or denied — allow clipboard access, or paste with the keyboard.',
          );
        }
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        const detail = error instanceof Error ? error.message : String(error);
        showToast('error', `Could not paste clipboard content. ${detail}`);
      });
  };

  // Right-click behavior is a preference: the terminal-emulator convention
  // (copy the selection when there is one, otherwise paste), always paste,
  // or a context menu. Paste goes through term.paste() so bracketed-paste
  // mode reaches the remote shell intact.
  const prepareRightClick = () => {
    const term = termRef.current;
    if (!term) return;
    term.options.rightClickSelectsWord = xtermRightClickSelectsWord(
      rightClickSelectsWordDefaultRef.current,
      usePrefsStore.getState().rightClickAction,
      term.hasSelection(),
    );
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    const intent = terminalRightClickIntent(
      usePrefsStore.getState().rightClickAction,
      terminalSelectionText(term),
    );
    if (intent.kind === 'menu') {
      setCtxMenu({ top: e.clientY, left: e.clientX, selection: intent.selection });
      return;
    }
    if (intent.kind === 'copy') {
      void copyToClipboard(intent.selection).then((ok) => {
        if (ok) term.clearSelection();
      });
      return;
    }
    pasteFromClipboard();
  };

  useEffect(() => {
    if (reconnectRequest === lastReconnectRequestRef.current) return;
    lastReconnectRequestRef.current = reconnectRequest;
    setGeneration((current) => current + 1);
  }, [reconnectRequest]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    terminalInputReadyRef.current = false;
    const shouldConnect = generation > 0;
    const reconnectCwd =
      tab.profile.kind === 'ssh' && tab.reconnectRequest > 0
        ? tab.terminalCwd
        : undefined;
    if (shouldConnect) {
      updateTab(tab.id, {
        status: 'connecting',
        connId: undefined,
        sftpAvailable: undefined,
        sftpOpen: false,
        terminalCwd: undefined,
      });
    }

    const prefs = usePrefsStore.getState();
    const initialFontSize = Math.min(
      MAX_FONT_SIZE,
      Math.max(MIN_FONT_SIZE, prefs.monoFontSize + zoomRef.current),
    );
    const initialFontStack = terminalFontStack(prefs.fontFamily);
    const term = new Terminal({
      fontSize: initialFontSize,
      fontFamily: initialFontStack,
      lineHeight: prefs.lineHeight,
      cursorBlink: prefs.cursorBlink,
      cursorStyle: prefs.cursorStyle,
      scrollback: prefs.scrollback,
      altClickMovesCursor: altClickMovesCursorForFileLinkActivation(
        prefs.terminalFileLinkActivation,
        IS_MAC,
      ),
      // ED2 pushes the screen into scrollback instead of blanking it, so a
      // shell that clears on login cannot destroy freshly restored history.
      scrollOnEraseInDisplay: true,
      allowProposedApi: true,
      // ImageAddon uses a bottom layer for negative-z Kitty placements.
      allowTransparency: true,
      theme: terminalTheme,
      // ANSI uses the same palette entries for foregrounds and backgrounds,
      // so combinations chosen by remote tools are not always legible in
      // every theme. Let xterm adjust only the rendered foreground as needed.
      minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO,
      // Shell-integration failure marks and search matches render here,
      // like VS Code's scrollbar annotations.
      scrollbar: { width: 14 },
      // icat &co discover cell pixel metrics via CSI 14/16 t when the PTY
      // reports no pixel size.
      windowOptions: { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true },
      // xterm 6.1 owns the Kitty keyboard state and key event lifecycle.
      // Installing a second encoder would emit printable keys twice.
      vtExtensions: { kittyKeyboard: true },
    });
    rightClickSelectsWordDefaultRef.current = term.options.rightClickSelectsWord ?? false;
    const fit = new FitAddon();
    fitRef.current = fit;
    termRef.current = term;
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(
      new WebLinksAddon((event, uri) =>
        openTerminalWebLink(
          event,
          uri,
          () =>
            terminalFileLinkActivationForPlatform(
              usePrefsStore.getState().terminalFileLinkActivation,
              IS_MAC,
            ),
          () => term.clearSelection(),
        ),
      ),
    );
    // xterm 6.1 streams Kitty APC payloads straight into ImageAddon's WASM
    // base64 decoder. This also handles Sixel and iTerm2 inline images.
    const image = new ImageAddon({
      kittySizeLimit: 64 * 1024 * 1024,
      storageLimit: active ? ACTIVE_IMAGE_STORAGE_MB : BACKGROUND_IMAGE_STORAGE_MB,
    });
    imageRef.current = image;
    term.loadAddon(image);
    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(search);
    const serialize = new SerializeAddon();
    serializeRef.current = serialize;
    term.loadAddon(serialize);
    const onSearchResults = search.onDidChangeResults(setSearchResult);
    term.open(el);
    // The pane is not always laid out by the time the terminal mounts, and a
    // pane opened behind another tab never is. The observer below catches the
    // first real size; until then the session keeps xterm's own default.
    let fitted = fitTerminal();
    keywordHighlighterRef.current = attachKeywordHighlighter(term, keywordHighlights);
    // Webfonts load lazily. Wait for both the selected text face and bundled
    // symbol face, then recalculate cells and repaint anything that arrived
    // while Chromium was still showing a fallback.
    void Promise.all([
      document.fonts.load(
        `${initialFontSize}px ${initialFontStack}`,
        '[15:58:10] root@rocker1:~',
      ),
      document.fonts.load(
        `${initialFontSize}px ${TERMINAL_SYMBOL_FONT}`,
        '\ue0b0\uf015\uf31b\u276f',
      ),
    ])
      .then(() => {
        if (termRef.current !== term) return;
        term.refresh(0, term.rows - 1);
        fitTerminal();
      })
      .catch(() => undefined);

    const encoder = new TextEncoder();
    let ready = false;
    // The server ignores input until the session exists, so keystrokes typed
    // into a pane that is still connecting wait here and go out the moment it
    // is ready — the type-ahead every real terminal gives you, which matters
    // most right after a split.
    let pendingInput: Uint8Array<ArrayBuffer>[] = [];
    let pendingInputBytes = 0;
    const flushPendingInput = () => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      for (const chunk of pendingInput) socket.send(chunk);
      pendingInput = [];
      pendingInputBytes = 0;
    };
    const sendInput = (data: string | Uint8Array<ArrayBuffer>): boolean => {
      const socket = wsRef.current;
      if (!socket || socket.readyState > WebSocket.OPEN) return false;
      const bytes = typeof data === 'string' ? encoder.encode(data) : data;
      if (ready && socket.readyState === WebSocket.OPEN) {
        socket.send(bytes);
        return true;
      }
      if (pendingInputBytes + bytes.length <= PENDING_INPUT_LIMIT) {
        pendingInput.push(bytes);
        pendingInputBytes += bytes.length;
      }
      return true;
    };

    attachOsc52Clipboard(
      term,
      (text) => {
        void copyToClipboard(text);
      },
      () => usePrefsStore.getState().allowOsc52ClipboardWrite,
      (data) => {
        sendInput(data);
      },
    );

    let transferPreparation: {
      resolve: (prepared: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
    } | undefined;
    const settleTransferPreparation = (prepared: boolean) => {
      const pending = transferPreparation;
      if (!pending) return;
      transferPreparation = undefined;
      clearTimeout(pending.timer);
      pending.resolve(prepared);
    };

    const unregister = registerTerminal(tab.id, {
      focus: () => term.focus(),
      cursorAnchorPosition: () => {
        const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
        if (!screen || term.cols <= 0 || term.rows <= 0) return undefined;
        const bounds = screen.getBoundingClientRect();
        const cursor = term.buffer.active;
        const column = Math.min(Math.max(cursor.cursorX, 0), term.cols - 1);
        const row = Math.min(Math.max(cursor.cursorY, 0), term.rows - 1);
        return {
          left: Math.round(bounds.left + ((column + 0.5) * bounds.width) / term.cols),
          top: Math.round(bounds.top + ((row + 1) * bounds.height) / term.rows),
        };
      },
      sendInput,
      clear: () => term.clear(),
      selectAll: () => term.selectAll(),
      hasSelection: () => term.hasSelection(),
      getSelection: () => terminalSelectionText(term),
      bufferText: () => bufferText(term),
      bufferHtml: () => serialize.serializeAsHTML({ includeGlobalBackground: true }),
      persistSnapshot: async () => {
        if (!usePrefsStore.getState().restoreScrollback) return;
        const data = serializeScrollback(serialize);
        if (data !== undefined) await putTerminalSnapshot(tab.id, data);
      },
      prepareTransfer: () => {
        const socket = wsRef.current;
        if (
          transferPreparation ||
          !socket ||
          socket.readyState !== WebSocket.OPEN
        ) {
          return Promise.resolve(false);
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (transferPreparation?.resolve !== resolve) return;
            transferPreparation = undefined;
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ op: 'cancel-transfer' }));
            }
            resolve(false);
          }, TRANSFER_PREPARE_TIMEOUT_MS);
          transferPreparation = { resolve, timer };
          socket.send(JSON.stringify({ op: 'prepare-transfer' }));
        });
      },
      cancelTransfer: () => {
        settleTransferPreparation(false);
        const socket = wsRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: 'cancel-transfer' }));
        }
      },
      zoomIn: () => applyZoom('in'),
      zoomOut: () => applyZoom('out'),
      zoomReset: () => applyZoom('reset'),
      zoomPercent: () => {
        const base = usePrefsStore.getState().monoFontSize;
        return Math.round(((base + zoomRef.current) / base) * 100);
      },
      paste: (text) =>
        pasteFromClipboard(() => Promise.resolve({ kind: 'text', text })),
      pasteClipboard: pasteFromClipboard,
      setLogging: (patch) => {
        const socket = wsRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify({ op: 'set-logging', ...patch }));
        return true;
      },
    });

    const onNativePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const text = event.clipboardData?.getData('text/plain');
      if (text) {
        pasteFromClipboard(() => Promise.resolve({ kind: 'text', text }));
      } else {
        pasteFromClipboard();
      }
    };
    el.addEventListener('paste', onNativePaste, true);

    // Ctrl+wheel zoom, the convention every terminal user tries first.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      applyZoom(event.deltaY < 0 ? 'in' : 'out');
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });

    const commandTracker = attachCommandTracker(term);
    const cwdTracker =
      tab.profile.kind === 'ssh' || tab.profile.kind === 'local'
        ? attachCwdTracker(term, (terminalCwd) => {
            const current = useTabsStore
              .getState()
              .tabs.find((candidate) => candidate.id === tab.id);
            if (current?.terminalCwd !== terminalCwd) updateTab(tab.id, { terminalCwd });
          })
        : undefined;
    const fileLinks =
      tab.profile.kind === 'ssh' || tab.profile.kind === 'local'
        ? attachTerminalFileLinks(
            term,
            (candidate) => openLinkedTerminalFile(tab.id, candidate),
            () =>
              terminalFileLinkActivationForPlatform(
                usePrefsStore.getState().terminalFileLinkActivation,
                IS_MAC,
              ),
            () => {
              const current = useTabsStore
                .getState()
                .tabs.find((candidate) => candidate.id === tab.id);
              return (
                current?.profile?.kind === 'local' ||
                (current?.profile?.kind === 'ssh' && current.sftpAvailable === true)
              );
            },
          )
        : undefined;

    // Application chords never reach xterm: the shortcut layer consumes them
    // in the capture phase, and anything it declines is encoded for the shell
    // (kitty keyboard protocol included) exactly as if Muxus had no bindings.
    const onSelection = term.onSelectionChange(() => {
      if (usePrefsStore.getState().copyOnSelect && term.hasSelection()) {
        void copyToClipboard(terminalSelectionText(term));
      }
    });
    const onNativeCopy = (event: ClipboardEvent) => {
      if (!term.hasSelection() || !event.clipboardData) return;
      const nativeSelection = term.getSelection();
      const selection = terminalSelectionText(term);
      if (selection === nativeSelection) return;
      event.clipboardData.setData('text/plain', selection);
      event.preventDefault();
      event.stopPropagation();
    };
    el.addEventListener('copy', onNativeCopy, { capture: true });

    let ws: WebSocket | undefined;
    let disposed = false;
    let exitMessage: TerminalExitMessage | undefined;
    let interruptionTimer: ReturnType<typeof setTimeout> | undefined;
    let rendererReattachTimer: ReturnType<typeof setTimeout> | undefined;
    let rendererStableTimer: ReturnType<typeof setTimeout> | undefined;
    let autoReconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let rendererReattachAttempts = 0;
    let terminalId = tab.transferId ? tab.terminalId : undefined;
    let pendingTransferId = tab.transferId;
    let sawAuthPrompt = false;
    let readyAt = 0;
    let snapshotDirty = false;
    let snapshotRevision = 0;
    let snapshotSaving = false;
    let unloadQueuedRevision: number | undefined;
    let receivedTerminalOutput = false;
    let waitingForTerminalOutput = false;
    let transportSuspect = false;
    let transientStatusVisible = false;
    const clearTransientStatus = () => {
      if (!transientStatusVisible) return;
      transientStatusVisible = false;
      term.write('\r\x1b[2K');
    };

    // Persist recent output in the background so a later restore can replay it.
    // Keep the buffer dirty until the request succeeds: an unload that races
    // an ordinary fetch must still queue a keepalive copy.
    const persistSnapshot = () => {
      if (
        !snapshotDirty ||
        snapshotSaving ||
        !usePrefsStore.getState().restoreScrollback
      ) {
        return;
      }
      const data = serializeScrollback(serialize);
      if (data === undefined) return;
      const savedRevision = snapshotRevision;
      snapshotSaving = true;
      void putTerminalSnapshot(tab.id, data).then((saved) => {
        snapshotSaving = false;
        if (saved && snapshotRevision === savedRevision) snapshotDirty = false;
      });
    };
    const snapshotTimer = setInterval(() => persistSnapshot(), TERMINAL_SNAPSHOT_INTERVAL_MS);
    // The interval alone would lose a command run seconds before the window
    // closes, so snapshot once output goes quiet as well.
    let quietSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleQuietSnapshot = () => {
      if (quietSnapshotTimer !== undefined) clearTimeout(quietSnapshotTimer);
      quietSnapshotTimer = setTimeout(() => {
        quietSnapshotTimer = undefined;
        persistSnapshot();
      }, TERMINAL_SNAPSHOT_QUIET_MS);
    };
    const unregisterUnloadFlush = registerUnloadKeepalive(
      (maxBodyBytes) => {
        if (!snapshotDirty || !usePrefsStore.getState().restoreScrollback) return 0;
        if (unloadQueuedRevision === snapshotRevision) return 0;
        const data = serializeScrollback(serialize, { maxBodyBytes });
        if (data === undefined) return 0;
        const savedRevision = snapshotRevision;
        unloadQueuedRevision = savedRevision;
        void putTerminalSnapshot(tab.id, data, { keepalive: true }).then((saved) => {
          if (saved && snapshotRevision === savedRevision) snapshotDirty = false;
          if (unloadQueuedRevision === savedRevision) unloadQueuedRevision = undefined;
        });
        return snapshotBodyBytes(data);
      },
      {
        priority: 0,
        isPending: () =>
          snapshotDirty &&
          usePrefsStore.getState().restoreScrollback &&
          unloadQueuedRevision !== snapshotRevision,
      },
    );
    const unsubscribePreferences = usePrefsStore.subscribe((state, previous) => {
      if (state.terminalFileLinkActivation !== previous.terminalFileLinkActivation) {
        term.options.altClickMovesCursor = altClickMovesCursorForFileLinkActivation(
          state.terminalFileLinkActivation,
          IS_MAC,
        );
      }
      if (
        previous.autoReconnectRemote &&
        !state.autoReconnectRemote &&
        autoReconnectTimer !== undefined
      ) {
        clearTimeout(autoReconnectTimer);
        autoReconnectTimer = undefined;
        autoReconnectAttemptsRef.current = Math.max(
          0,
          autoReconnectAttemptsRef.current - 1,
        );
        term.write(
          '\x1b[1;36mAutomatic reconnect disabled — press any key to reconnect\x1b[0m\r\n',
        );
      }
    });

    const openSocket = (attachTerminalId?: string) => {
      const socket = new WebSocket(wsUrl('/ws/terminal'), wsProtocols());
      const attachingExistingSession = !!attachTerminalId;
      let socketFailed = false;
      ws = socket;
      wsRef.current = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        // The pane is usually laid out by the time the socket opens, even when
        // it was not when the terminal mounted. Measure now so the remote PTY
        // starts at the size on screen instead of being resized a beat later.
        if (!fitted) fitted = fitTerminal();
        socket.send(JSON.stringify(
          attachTerminalId
            ? {
                op: 'attach',
                terminalId: attachTerminalId,
                cols: term.cols,
                rows: term.rows,
              }
            : {
                op: 'connect',
                profile: tab.profile,
                title: tab.title,
                cols: term.cols,
                rows: term.rows,
              },
        ));
      };
      socket.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          clearTransientStatus();
          notifyOutput(tab.id);
          receivedTerminalOutput = true;
          snapshotDirty = true;
          snapshotRevision += 1;
          scheduleQuietSnapshot();
          if (waitingForTerminalOutput) {
            waitingForTerminalOutput = false;
            if (!transportSuspect) {
              updateTab(tab.id, {
                status: 'connected',
                failureReason: undefined,
                disconnectReason: undefined,
              });
            }
          }
          term.write(new Uint8Array(ev.data));
          return;
        }
        if (typeof ev.data !== 'string') return;
        let ctl: TerminalServerMessage;
        try {
          ctl = JSON.parse(ev.data) as TerminalServerMessage;
        } catch {
          term.write(ev.data);
          return;
        }
        switch (ctl.op) {
          case 'session':
            terminalId = ctl.terminalId;
            updateTab(tab.id, { terminalId: ctl.terminalId });
            break;
          case 'transfer-ready': {
            const pending = transferPreparation;
            if (pending) {
              // WebSocket frames are ordered, but xterm applies writes
              // asynchronously. Drain all pre-freeze output before snapshotting.
              term.write('', () => {
                if (transferPreparation === pending) settleTransferPreparation(true);
              });
            }
            break;
          }
          case 'status': {
            if (!ready && !transportSuspect) {
              updateTab(tab.id, {
                status: 'connecting',
                connId: undefined,
                failureReason: undefined,
                disconnectReason: undefined,
              });
            }
            clearTransientStatus();
            if (ctl.transient) {
              const message = terminalNotice(ctl.message).slice(
                0,
                Math.max(1, term.cols - 1),
              );
              term.write(`\r\x1b[90m${message}\x1b[0m`);
              transientStatusVisible = true;
            } else {
              term.write(`\x1b[90m${ctl.message}\x1b[0m\r\n`);
            }
            break;
          }
          case 'connection-health':
            transportSuspect = ctl.state === 'suspect';
            if (transportSuspect) {
              updateTab(tab.id, {
                status: 'interrupted',
                failureReason: 'The SSH transport is not responding.',
                disconnectReason: undefined,
              });
            } else if (ready) {
              updateTab(tab.id, {
                status: waitingForTerminalOutput ? 'connecting' : 'connected',
                failureReason: undefined,
                disconnectReason: undefined,
              });
            }
            break;
          case 'auth-prompt':
            sawAuthPrompt = true;
            setAuthPrompt({
              name: ctl.name,
              instructions: ctl.instructions,
              host: ctl.host,
              prompts: ctl.prompts,
              purpose: ctl.purpose,
              rememberPassword: ctl.rememberPassword,
              skipLabel: ctl.skipLabel,
            });
            break;
          case 'host-key':
            setHostKey(ctl);
            break;
          case 'ready': {
            ready = true;
            terminalInputReadyRef.current = true;
            if (!attachingExistingSession || readyAt === 0) readyAt = Date.now();
            if (!attachingExistingSession) rendererReattachAttempts = 0;
            if (rendererStableTimer !== undefined) clearTimeout(rendererStableTimer);
            rendererStableTimer = setTimeout(() => {
              rendererStableTimer = undefined;
              rendererReattachAttempts = 0;
            }, AUTO_RECONNECT_STABLE_MS);
            if (rendererReattachTimer !== undefined) {
              clearTimeout(rendererReattachTimer);
              rendererReattachTimer = undefined;
            }
            if (interruptionTimer !== undefined) {
              clearTimeout(interruptionTimer);
              interruptionTimer = undefined;
            }
            clearTransientStatus();
            waitingForTerminalOutput = pendingTransferId
              ? false
              : shouldWaitForTerminalOutput(tab.profile.kind, receivedTerminalOutput);
            const sftpAvailable =
              tab.profile.kind === 'ssh' ? ctl.sftpAvailable !== false : undefined;
            updateTab(tab.id, {
              status: transportSuspect
                ? 'interrupted'
                : waitingForTerminalOutput
                  ? 'connecting'
                  : 'connected',
              failureReason: undefined,
              disconnectReason: undefined,
              // Only SSH transport IDs are valid SFTP/forwarding lease keys.
              connId: tab.profile.kind === 'ssh' ? ctl.connId : undefined,
              sftpAvailable,
              ...(sftpAvailable === false ? { sftpOpen: false } : {}),
              transferId: undefined,
            });
            if (pendingTransferId) {
              completeTabTransfer(pendingTransferId);
              pendingTransferId = undefined;
            }
            const current = useTabsStore
              .getState()
              .tabs.find((candidate) => candidate.id === tab.id);
            if (!attachingExistingSession && current?.profile?.kind === 'ssh') {
              const recoveryInput = current.reconnectMode
                ? reattachCommand(current.reconnectMode)
                : restoreCwdCommand(reconnectCwd);
              if (recoveryInput) socket.send(encoder.encode(recoveryInput));
            }
            flushPendingInput();
            break;
          }
          case 'logging-state':
            updateTab(tab.id, {
              loggingEnabled: ctl.enabled,
              sessionLogId: ctl.sessionId,
              loggingWarning: ctl.warning,
              loggingPaused: ctl.paused,
              captureInput: ctl.captureInput,
            });
            if (ctl.warning) showToast('warning', ctl.warning);
            break;
          case 'exit':
            exitMessage = ctl;
            break;
        }
      };
      socket.onerror = () => {
        socketFailed = true;
      };
      socket.onclose = (event) => {
        terminalInputReadyRef.current = false;
        if (wsRef.current === socket) wsRef.current = null;
        if (disposed) return;
        clearTransientStatus();
        const reason =
          socketFailed && !ready && !exitMessage
            ? 'Could not reach the Muxus backend.'
            : connectionFailureReason(exitMessage, event);
        const reasonKind = exitMessage?.reason ?? (ready ? 'disconnected' : 'failed');
        setAuthPrompt(null);
        setHostKey(null);

        // Cross-window handoff intentionally replaces this renderer. The
        // destination owns the terminal now and will retire this source tab.
        if (event.code === 1000 && event.reason === 'terminal transferred') return;

        // A renderer socket can be severed by laptop sleep while the backend
        // PTY/channel is still healthy. Reuse its stable id before considering
        // a replacement connection or shell.
        if (!exitMessage && terminalId) {
          const delay = rendererReattachDelayMs(rendererReattachAttempts);
          if (delay !== undefined) {
            rendererReattachAttempts += 1;
            updateTab(tab.id, {
              status: 'interrupted',
              failureReason: reason,
              disconnectReason: undefined,
            });
            rendererReattachTimer = setTimeout(() => {
              rendererReattachTimer = undefined;
              if (!disposed && terminalId) openSocket(terminalId);
            }, delay);
            return;
          }
        }

        const showFinalState = () => {
          // A drop after a stable stretch is a fresh incident, not one more
          // failure of the previous redial chain.
          if (readyAt !== 0 && Date.now() - readyAt >= AUTO_RECONNECT_STABLE_MS) {
            autoReconnectAttemptsRef.current = 0;
          }
          const redialDelay = autoReconnectDelayMs({
            enabled: usePrefsStore.getState().autoReconnectRemote,
            profileKind: tab.profile.kind,
            reason: reasonKind,
            attempts: autoReconnectAttemptsRef.current,
            sawAuthPrompt,
          });
          term.write(
            `\r\n\x1b[${reasonKind === 'completed' ? '33' : '31'}m[${
              reasonKind === 'completed' ? 'session ended' : 'connection lost'
            }: ${terminalNotice(reason)}]\x1b[0m\r\n`,
          );
          if (redialDelay === undefined) {
            term.write('\x1b[1;36mPress any key to reconnect\x1b[0m\r\n');
          } else {
            autoReconnectAttemptsRef.current += 1;
            term.write(
              `\x1b[1;36mReconnecting in ${Math.round(redialDelay / 1000)}s (attempt ${autoReconnectAttemptsRef.current} of ${AUTO_RECONNECT_DELAYS_MS.length}) — any key reconnects now\x1b[0m\r\n`,
            );
            autoReconnectTimer = setTimeout(() => {
              autoReconnectTimer = undefined;
              if (!usePrefsStore.getState().autoReconnectRemote) {
                autoReconnectAttemptsRef.current = Math.max(
                  0,
                  autoReconnectAttemptsRef.current - 1,
                );
                return;
              }
              const state = useTabsStore.getState();
              const current = state.tabs.find((candidate) => candidate.id === tab.id);
              if (current?.status !== 'closed') return;
              state.reconnect(
                [tab.id],
                current.reconnectMode ? { reattach: current.reconnectMode } : undefined,
              );
            }, redialDelay);
          }
          updateTab(tab.id, {
            status: 'closed',
            connId: undefined,
            terminalId: undefined,
            failureReason: reason,
            disconnectReason: reasonKind,
          });
        };

        if (!shouldDelayConnectionLost(exitMessage, ready)) {
          showFinalState();
          return;
        }

        updateTab(tab.id, {
          status: 'interrupted',
          connId: undefined,
          terminalId: undefined,
          failureReason: reason,
          disconnectReason: reasonKind,
        });
        interruptionTimer = setTimeout(() => {
          const current = useTabsStore
            .getState()
            .tabs.find((candidate) => candidate.id === tab.id);
          if (current?.status !== 'interrupted') return;
          showFinalState();
        }, CONNECTION_INTERRUPTION_GRACE_MS);
      };
    };

    // Replay what this tab showed before — buffer carried over a reconnect,
    // or the stored snapshot on the first mount of a restored tab — and only
    // then let the new session write, so its output lands below the divider.
    const boot = async () => {
      let replay = carryBufferRef.current;
      carryBufferRef.current = null;
      if (
        replay === null &&
        tab.restored &&
        !snapshotFetchedRef.current &&
        usePrefsStore.getState().restoreScrollback
      ) {
        const fetched = await fetchTerminalSnapshot(tab.id);
        // A torn-down run must not latch the ref: the replacement effect run
        // repeats the fetch instead of silently restoring nothing.
        if (disposed) return;
        snapshotFetchedRef.current = true;
        replay = fetched;
      }
      if (replay) {
        term.write(replay);
        term.write(TERMINAL_HISTORY_DIVIDER);
      }
      if (shouldConnect) {
        openSocket(pendingTransferId ? terminalId : undefined);
      } else {
        term.write('\x1b[90m[restored session]\x1b[0m\r\n');
        term.write('\x1b[1;36mPress any key to reconnect\x1b[0m\r\n');
      }
    };
    void boot();

    const reconnectFromTerminalInput = (): boolean => {
      const state = useTabsStore.getState();
      const current = state.tabs.find((candidate) => candidate.id === tab.id);
      if (!current?.profile || current.status !== 'closed') return false;
      state.reconnect(
        [tab.id],
        current.reconnectMode ? { reattach: current.reconnectMode } : undefined,
      );
      return true;
    };

    // onKey fires synchronously before onData and carries the DOM event that
    // produced the encoded bytes. Keep it only long enough to normalize that
    // one emission; protocol replies and programmatic input have no key event.
    let inputKeyEvent: KeyboardEvent | undefined;
    const onKey = term.onKey(({ domEvent }) => {
      inputKeyEvent = domEvent;
    });
    const onData = term.onData((data) => {
      const normalized = normalizeTerminalKeyboardInput(data, inputKeyEvent, IS_MAC);
      inputKeyEvent = undefined;
      const broadcast = !suppressNextInputBroadcastRef.current;
      suppressNextInputBroadcastRef.current = false;
      if (sendInput(normalized)) {
        if (broadcast) broadcastTerminalInput(tab.id, normalized);
      } else {
        reconnectFromTerminalInput();
      }
    });
    const onBinary = term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      if (sendInput(bytes)) broadcastTerminalInput(tab.id, bytes);
      else reconnectFromTerminalInput();
    });
    const onResize = term.onResize(({ cols, rows }) => {
      const socket = wsRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ op: 'resize', cols, rows }));
      }
    });

    // Dragging a side panel — and the open/close transitions of those panels —
    // change our width on every animation frame. Fitting each frame reflows the
    // buffer and SIGWINCHes the remote shell dozens of times per drag, and the
    // shell repaints its prompt at every intermediate width, which leaves
    // redraw debris in the scrollback. Fit once the width holds still instead.
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      // The first measurable size — the layout landing, or a pane opened
      // behind another tab finally coming to the front — is not a drag, and
      // waiting it out would let the session connect at the wrong width.
      if (!fitted) {
        fitted = fitTerminal();
        if (fitted) return;
      }
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = undefined;
        fitTerminal();
      }, RESIZE_SETTLE_MS);
    });
    observer.observe(el);

    return () => {
      disposed = true;
      settleTransferPreparation(false);
      clearInterval(snapshotTimer);
      if (quietSnapshotTimer !== undefined) clearTimeout(quietSnapshotTimer);
      unregisterUnloadFlush();
      unsubscribePreferences();
      // The buffer outlives this socket generation: a reconnect replays it in
      // place, and the stored copy keeps the tail output a restart would lose.
      if (usePrefsStore.getState().restoreScrollback) {
        const data = serializeScrollback(serialize);
        carryBufferRef.current = data ?? null;
        if (snapshotDirty && data !== undefined) {
          void putTerminalSnapshot(tab.id, data);
        }
      } else {
        carryBufferRef.current = null;
      }
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      observer.disconnect();
      unregister();
      el.removeEventListener('paste', onNativePaste, true);
      el.removeEventListener('wheel', onWheel, true);
      onKey.dispose();
      onData.dispose();
      onBinary.dispose();
      onResize.dispose();
      onSelection.dispose();
      el.removeEventListener('copy', onNativeCopy, { capture: true });
      onSearchResults.dispose();
      commandTracker.dispose();
      cwdTracker?.dispose();
      fileLinks?.dispose();
      keywordHighlighterRef.current?.dispose();
      if (interruptionTimer !== undefined) clearTimeout(interruptionTimer);
      if (rendererReattachTimer !== undefined) clearTimeout(rendererReattachTimer);
      if (rendererStableTimer !== undefined) clearTimeout(rendererStableTimer);
      if (autoReconnectTimer !== undefined) clearTimeout(autoReconnectTimer);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        closeTerminalWebSocket(ws);
      }
      term.dispose();
      searchRef.current = null;
      serializeRef.current = null;
      imageRef.current = null;
      keywordHighlighterRef.current = null;
      termRef.current = null;
      terminalInputReadyRef.current = false;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, generation]);

  // Preferences apply live to the running terminal — no reopen needed.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const nextFontSize = Math.min(
      MAX_FONT_SIZE,
      Math.max(MIN_FONT_SIZE, monoFontSize + zoomRef.current),
    );
    const nextFontStack = terminalFontStack(fontFamily);
    term.options.fontSize = nextFontSize;
    term.options.fontFamily = nextFontStack;
    term.options.lineHeight = lineHeight;
    term.options.cursorBlink = cursorBlink;
    term.options.cursorStyle = cursorStyle;
    term.options.scrollback = scrollback;
    term.options.theme = terminalTheme;
    fitTerminal();
    void document.fonts
      .load(`${nextFontSize}px ${nextFontStack}`, '[15:58:10] root@rocker1:~')
      .then(() => {
        if (
          termRef.current !== term ||
          term.options.fontFamily !== nextFontStack ||
          term.options.fontSize !== nextFontSize
        ) {
          return;
        }
        term.refresh(0, term.rows - 1);
        fitTerminal();
      })
      .catch(() => undefined);
  }, [monoFontSize, fontFamily, lineHeight, cursorBlink, cursorStyle, scrollback, terminalTheme, generation]);

  useEffect(() => {
    keywordHighlighterRef.current?.setRules(keywordHighlights);
  }, [keywordHighlights, generation]);

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (searchRequest === lastSearchRequestRef.current) return;
    lastSearchRequestRef.current = searchRequest;
    setSearchOpen(true);
  }, [searchRequest]);

  useEffect(() => {
    const search = searchRef.current;
    if (!search) return;
    if (!searchOpen || !searchQuery) {
      search.clearDecorations();
      setSearchResult({ resultIndex: -1, resultCount: 0 });
      return;
    }
    search.findNext(searchQuery, { ...searchOptions, incremental: true });
  }, [searchOpen, searchQuery, searchOptions]);

  // Refit when this tab becomes visible (display:none panes have zero size).
  useEffect(() => {
    if (imageRef.current) {
      imageRef.current.storageLimit = active
        ? ACTIVE_IMAGE_STORAGE_MB
        : BACKGROUND_IMAGE_STORAGE_MB;
    }
    if (active) {
      requestAnimationFrame(() => {
        fitTerminal();
        termRef.current?.focus();
      });
    }
  }, [active, generation]);

  const answerAuth = (response: AuthPromptResult | null) => {
    setAuthPrompt(null);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (response === null) ws.close();
    else ws.send(JSON.stringify({ op: 'auth-response', ...response }));
  };

  const answerHostKey = (accept: boolean) => {
    setHostKey(null);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'host-key-response', accept }));
  };

  const closeCtxMenu = () => {
    setCtxMenu(null);
    termRef.current?.focus();
  };

  return (
    <Box sx={{ height: '100%', p: 1, pt: 0.75, minHeight: 0, position: 'relative' }}>
      <Box
        ref={containerRef}
        onMouseDownCapture={(event) => {
          // Firefox runs xterm's right-click handler on mousedown.
          if (event.button === 2) prepareRightClick();
        }}
        onContextMenuCapture={prepareRightClick}
        onContextMenu={onContextMenu}
        sx={{
          height: '100%',
          bgcolor: terminalTheme.background,
          border: 1,
          borderColor: theme.palette.mode === 'dark' && !scheme.light ? 'transparent' : theme.palette.divider,
          borderRadius: 1,
          overflow: 'hidden',
          '& .xterm': { height: '100%', p: theme.spacing(0.5) },
          // xterm.css defaults the viewport to #000, which shows through the
          // .xterm padding as a black ring around the canvas.
          '& .xterm .xterm-viewport': { backgroundColor: 'transparent' },
        }}
      />
      {searchOpen && (
        <Paper
          elevation={8}
          sx={{
            position: 'absolute',
            zIndex: 6,
            top: 11,
            right: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            p: 0.5,
            border: 1,
            borderColor: 'divider',
          }}
        >
          <TextField
            inputRef={searchInputRef}
            size="small"
            placeholder="Find in terminal"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchOpen(false);
                termRef.current?.focus();
              } else if (event.key === 'Enter' && searchQuery) {
                if (event.shiftKey) searchRef.current?.findPrevious(searchQuery, searchOptions);
                else searchRef.current?.findNext(searchQuery, searchOptions);
              }
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 17 }} />
                  </InputAdornment>
                ),
                endAdornment: searchQuery ? (
                  <InputAdornment position="end">
                    <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                      {searchResult.resultCount > 0
                        ? `${searchResult.resultIndex + 1}/${searchResult.resultCount}`
                        : 'No matches'}
                    </Typography>
                  </InputAdornment>
                ) : undefined,
              },
            }}
            sx={{ width: 240 }}
          />
          <Tooltip title="Match case">
            <ToggleButton
              value="case"
              size="small"
              selected={searchCase}
              onChange={() => setSearchCase((v) => !v)}
              sx={{ px: 0.75, py: 0.25, fontSize: 12, textTransform: 'none', border: 0 }}
            >
              Aa
            </ToggleButton>
          </Tooltip>
          <Tooltip title="Whole word">
            <ToggleButton
              value="word"
              size="small"
              selected={searchWord}
              onChange={() => setSearchWord((v) => !v)}
              sx={{ px: 0.75, py: 0.25, fontSize: 12, textTransform: 'none', border: 0 }}
            >
              W
            </ToggleButton>
          </Tooltip>
          <Tooltip title="Regular expression">
            <ToggleButton
              value="regex"
              size="small"
              selected={searchRegex}
              onChange={() => setSearchRegex((v) => !v)}
              sx={{ px: 0.75, py: 0.25, fontSize: 12, textTransform: 'none', border: 0 }}
            >
              .*
            </ToggleButton>
          </Tooltip>
          <Tooltip title="Previous match (Shift+Enter)">
            <span>
              <IconButton
                size="small"
                aria-label="Previous terminal search match"
                disabled={!searchQuery}
                onClick={() => searchRef.current?.findPrevious(searchQuery, searchOptions)}
              >
                <KeyboardArrowUpIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Next match (Enter)">
            <span>
              <IconButton
                size="small"
                aria-label="Next terminal search match"
                disabled={!searchQuery}
                onClick={() => searchRef.current?.findNext(searchQuery, searchOptions)}
              >
                <KeyboardArrowDownIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <IconButton
            size="small"
            aria-label="Close terminal search"
            onClick={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Paper>
      )}
      <Menu
        open={!!ctxMenu}
        onClose={closeCtxMenu}
        anchorReference="anchorPosition"
        anchorPosition={ctxMenu ?? undefined}
      >
        <MenuItem
          disabled={!ctxMenu?.selection}
          onClick={() => {
            const term = termRef.current;
            const selection = ctxMenu?.selection;
            if (term && selection) {
              void copyToClipboard(selection).then((ok) => {
                if (ok) term.clearSelection();
              });
            }
            closeCtxMenu();
          }}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy</ListItemText>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>
            Ctrl+Shift+C
          </Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeCtxMenu();
            pasteFromClipboard();
          }}
        >
          <ListItemIcon>
            <ContentPasteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Paste</ListItemText>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>
            Ctrl+Shift+V
          </Typography>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            termRef.current?.selectAll();
            setCtxMenu(null);
          }}
        >
          <ListItemIcon>
            <SelectAllIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Select all</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeCtxMenu();
            setSearchOpen(true);
          }}
        >
          <ListItemIcon>
            <SearchIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Find</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            const term = termRef.current;
            if (term) saveTextFile(exportFilename(tab.title, 'txt'), bufferText(term));
            closeCtxMenu();
          }}
        >
          <ListItemIcon>
            <DescriptionOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Export as text</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            const serialize = serializeRef.current;
            if (serialize) saveTextFile(exportFilename(tab.title, 'html'), serialize.serializeAsHTML({ includeGlobalBackground: true }), 'text/html');
            closeCtxMenu();
          }}
        >
          <ListItemIcon>
            <CodeOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Export as HTML</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            termRef.current?.clear();
            closeCtxMenu();
          }}
        >
          <ListItemIcon>
            <DeleteSweepOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Clear scrollback</ListItemText>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>
            Ctrl+Shift+K
          </Typography>
        </MenuItem>
      </Menu>
      <AuthPromptDialog request={authPrompt} onSubmit={answerAuth} />
      <HostKeyDialog request={hostKey} onAnswer={answerHostKey} />
      {pendingPaste !== null ? (
        <PasteConfirmDialog
          initialText={pendingPaste.text}
          onCancel={() => {
            setPendingPaste(null);
            pendingPasteResolverRef.current = null;
            pendingPaste.resolve();
          }}
          onConfirm={(text) => {
            setPendingPaste(null);
            pendingPasteResolverRef.current = null;
            pasteToTerminal(text, pendingPaste.broadcast);
            pendingPaste.resolve();
            termRef.current?.focus();
          }}
        />
      ) : null}
    </Box>
  );
}
