import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
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
import type { TerminalServerMessage } from '@muxus/shared';
import { wsProtocols, wsUrl } from '../api/http.js';
import { copyToClipboard, readFromClipboard } from '../clipboard.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { showToast } from '../state/toast.js';
import { broadcastTerminalInput } from '../state/multi-exec.js';
import { terminalFontStack, usePrefsStore } from '../state/prefs.js';
import { useTabsStore, type SessionTab } from '../state/tabs.js';
import { KittyApcExtractor, type StreamPart } from '../terminal/apc-stream.js';
import { KittyGraphicsEngine } from '../terminal/kitty-graphics.js';
import { KittyKeyboardHandler } from '../terminal/kitty-keyboard.js';
import { terminalScheme } from '../terminal/palette.js';
import { attachCommandTracker } from '../terminal/shell-integration.js';
import { registerTerminal } from '../terminal/terminal-registry.js';
import { requiresPasteConfirmation } from '../terminal/paste-safety.js';
import { AuthPromptDialog, type AuthPromptRequest } from './AuthPromptDialog.js';
import { HostKeyDialog, type HostKeyRequest } from './HostKeyDialog.js';
import { PasteConfirmDialog } from './PasteConfirmDialog.js';

const SEARCH_DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#594b24',
  matchOverviewRuler: '#d7b84b',
  activeMatchBackground: '#b77b23',
  activeMatchColorOverviewRuler: '#ffb74d',
};

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 40;

/**
 * Serializes terminal writes with graphics commands. Plain data is written
 * fire-and-forget; a graphics command first drains the parser (empty write
 * with callback) so the cursor position it anchors to is exact, then runs
 * the engine and injects the cursor advance — all while later stream parts
 * queue behind it.
 */
class GraphicsPipeline {
  private chain: Promise<void> | null = null;

  constructor(
    private readonly term: Terminal,
    private readonly engine: KittyGraphicsEngine,
    private readonly sendToApp: (data: string) => void,
  ) {}

  push(parts: StreamPart[]): void {
    for (const part of parts) {
      if (part.kind === 'data') {
        const data = part.data;
        if (this.chain) this.chain = this.chain.then(() => this.term.write(data));
        else this.term.write(data);
      } else {
        const cmd = part.cmd;
        this.chain = (this.chain ?? Promise.resolve())
          .then(() => new Promise<void>((resolve) => this.term.write('', resolve)))
          .then(() => this.engine.handle(cmd))
          .then((result) => {
            if (result.response) this.sendToApp(result.response);
            if (result.advance) this.term.write(result.advance);
          })
          .catch(() => {
            /* a broken image must not stall the stream */
          });
      }
    }
    const current = this.chain;
    if (current) {
      void current.then(() => {
        if (this.chain === current) this.chain = null;
      });
    }
  }
}

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

export default function TerminalViewImpl({ tab, active }: { tab: SessionTab; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastSearchRequestRef = useRef(tab.searchRequest);
  /** Per-tab zoom offset added to the preference font size. */
  const zoomRef = useRef(0);
  const theme = useTheme();
  const [authPrompt, setAuthPrompt] = useState<AuthPromptRequest | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyRequest | null>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchWord, setSearchWord] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchResult, setSearchResult] = useState({ resultIndex: -1, resultCount: 0 });
  const [ctxMenu, setCtxMenu] = useState<{ top: number; left: number; hasSelection: boolean } | null>(null);
  const [generation, setGeneration] = useState(tab.connectOnMount ? 0 : -1);
  const updateTab = useTabsStore((s) => s.update);
  const status = useTabsStore((s) => s.tabs.find((t) => t.id === tab.id)?.status);
  const searchRequest = useTabsStore(
    (s) => s.tabs.find((candidate) => candidate.id === tab.id)?.searchRequest ?? 0,
  );
  const monoFontSize = usePrefsStore((s) => s.monoFontSize);
  const fontFamily = usePrefsStore((s) => s.fontFamily);
  const lineHeight = usePrefsStore((s) => s.lineHeight);
  const cursorBlink = usePrefsStore((s) => s.cursorBlink);
  const cursorStyle = usePrefsStore((s) => s.cursorStyle);
  const scrollback = usePrefsStore((s) => s.scrollback);
  const schemeId = usePrefsStore((s) => s.terminalScheme);
  const scheme = terminalScheme(schemeId);

  const searchOptions = useMemo<ISearchOptions>(
    () => ({
      caseSensitive: searchCase,
      wholeWord: searchWord,
      regex: searchRegex,
      decorations: SEARCH_DECORATIONS,
    }),
    [searchCase, searchWord, searchRegex],
  );

  const pasteText = (text: string) => {
    if (usePrefsStore.getState().pasteWarnMultiline && requiresPasteConfirmation(text)) {
      setSearchOpen(false);
      setPendingPaste(text);
      return;
    }
    termRef.current?.paste(text);
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
      fitRef.current?.fit();
    }
  };

  const pasteFromClipboard = () => {
    void readFromClipboard().then((text) => {
      if (text === null) {
        showToast('warning', 'Clipboard read unavailable or denied — allow clipboard access, or paste with the keyboard.');
        return;
      }
      if (text) pasteText(text);
    });
  };

  // Right-click behavior is a preference: the terminal-emulator convention
  // (copy the selection when there is one, otherwise paste), always paste,
  // or a context menu. Paste goes through term.paste() so bracketed-paste
  // mode reaches the remote shell intact.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    const action = usePrefsStore.getState().rightClickAction;
    if (action === 'menu') {
      setCtxMenu({ top: e.clientY, left: e.clientX, hasSelection: term.hasSelection() });
      return;
    }
    if (action === 'copy-paste') {
      const selection = term.getSelection();
      if (selection) {
        void copyToClipboard(selection).then((ok) => {
          if (ok) term.clearSelection();
        });
        return;
      }
    }
    pasteFromClipboard();
  };

  useEffect(() => {
    if (generation < 0) return;
    const el = containerRef.current;
    if (!el) return;
    updateTab(tab.id, { status: 'connecting' });

    const prefs = usePrefsStore.getState();
    const term = new Terminal({
      fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, prefs.monoFontSize + zoomRef.current)),
      fontFamily: terminalFontStack(prefs.fontFamily),
      lineHeight: prefs.lineHeight,
      cursorBlink: prefs.cursorBlink,
      cursorStyle: prefs.cursorStyle,
      scrollback: prefs.scrollback,
      allowProposedApi: true,
      theme: terminalScheme(prefs.terminalScheme).theme,
      // Shell-integration failure marks and search matches render here,
      // like VS Code's scrollbar annotations.
      overviewRuler: { width: 14 },
      // icat &co discover cell pixel metrics via CSI 14/16 t when the PTY
      // reports no pixel size.
      windowOptions: { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    termRef.current = term;
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon());
    // Sixel + iTerm2 inline images ride along; kitty graphics are ours.
    term.loadAddon(new ImageAddon());
    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(search);
    const serialize = new SerializeAddon();
    serializeRef.current = serialize;
    term.loadAddon(serialize);
    const onSearchResults = search.onDidChangeResults(setSearchResult);
    term.open(el);
    fit.fit();

    const encoder = new TextEncoder();
    const sendInput = (data: string | Uint8Array<ArrayBuffer>): boolean => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(typeof data === 'string' ? encoder.encode(data) : data);
      return true;
    };

    const unregister = registerTerminal(tab.id, {
      focus: () => term.focus(),
      sendInput,
      clear: () => term.clear(),
      selectAll: () => term.selectAll(),
      hasSelection: () => term.hasSelection(),
      getSelection: () => term.getSelection(),
      bufferText: () => bufferText(term),
      bufferHtml: () => serialize.serializeAsHTML({ includeGlobalBackground: true }),
      zoomIn: () => applyZoom('in'),
      zoomOut: () => applyZoom('out'),
      zoomReset: () => applyZoom('reset'),
      zoomPercent: () => {
        const base = usePrefsStore.getState().monoFontSize;
        return Math.round(((base + zoomRef.current) / base) * 100);
      },
      paste: (text) => pasteText(text),
    });

    const onNativePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text || !usePrefsStore.getState().pasteWarnMultiline || !requiresPasteConfirmation(text)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setSearchOpen(false);
      setPendingPaste(text);
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

    const sendToApp = (data: string) => {
      sendInput(data);
    };

    const commandTracker = attachCommandTracker(term);
    const graphics = new KittyGraphicsEngine(term);
    graphics.attach();
    const keyboard = new KittyKeyboardHandler(term);
    keyboard.attach();
    const extractor = new KittyApcExtractor();
    const pipeline = new GraphicsPipeline(term, graphics, sendToApp);

    term.attachCustomKeyEventHandler((ev) => {
      // Ctrl+Shift chords stay ours (kitty reserves ctrl+shift for the terminal).
      if (ev.type === 'keydown' && (ev.ctrlKey || ev.metaKey) && ev.shiftKey && !ev.altKey) {
        if (ev.code === 'KeyC' && term.hasSelection()) {
          void copyToClipboard(term.getSelection());
          return false;
        }
        if (ev.code === 'KeyV') {
          void readFromClipboard().then((text) => {
            if (text) pasteText(text);
          });
          return false;
        }
        if (ev.code === 'KeyF') {
          setSearchOpen(true);
          return false;
        }
        if (ev.code === 'KeyA') {
          term.selectAll();
          return false;
        }
        if (ev.code === 'KeyK') {
          term.clear();
          return false;
        }
        if (ev.code === 'Equal' || ev.code === 'Minus' || ev.code === 'Digit0') {
          applyZoom(ev.code === 'Equal' ? 'in' : ev.code === 'Minus' ? 'out' : 'reset');
          return false;
        }
        if (ev.code === 'KeyT') return true; // bubbles to the app shortcut
      }
      // Tab cycling works while the terminal has focus.
      if (ev.type === 'keydown' && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.code === 'PageUp' || ev.code === 'PageDown')) {
        return true; // bubbles to the app shortcut
      }
      if (keyboard.handleKey(ev)) return false;
      return true;
    });

    const onSelection = term.onSelectionChange(() => {
      if (usePrefsStore.getState().copyOnSelect && term.hasSelection()) void copyToClipboard(term.getSelection());
    });

    const ws = new WebSocket(wsUrl('/ws/terminal'), wsProtocols());
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'connect', profile: tab.profile, cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        pipeline.push(extractor.feed(new Uint8Array(ev.data)));
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
        case 'status':
          term.write(`\x1b[90m${ctl.message}\x1b[0m\r\n`);
          break;
        case 'auth-prompt':
          setAuthPrompt({ name: ctl.name, instructions: ctl.instructions, host: ctl.host, prompts: ctl.prompts });
          break;
        case 'host-key':
          setHostKey(ctl);
          break;
        case 'ready':
          updateTab(tab.id, { status: 'connected', connId: ctl.connId.startsWith('local-') ? undefined : ctl.connId });
          break;
        case 'exit':
          term.write(`\r\n\x1b[33m[session ended${ctl.message ? `: ${ctl.message}` : ''}]\x1b[0m\r\n`);
          break;
      }
    };
    ws.onclose = () => {
      term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
      setAuthPrompt(null);
      setHostKey(null);
      updateTab(tab.id, { status: 'closed', connId: undefined });
    };

    const onData = term.onData((data) => {
      if (sendInput(data)) broadcastTerminalInput(tab.id, data);
    });
    const onBinary = term.onBinary((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      ws.send(bytes);
      broadcastTerminalInput(tab.id, bytes);
    });
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'resize', cols, rows }));
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    return () => {
      observer.disconnect();
      unregister();
      el.removeEventListener('paste', onNativePaste, true);
      el.removeEventListener('wheel', onWheel, true);
      onData.dispose();
      onBinary.dispose();
      onResize.dispose();
      onSelection.dispose();
      onSearchResults.dispose();
      keyboard.dispose();
      graphics.dispose();
      commandTracker.dispose();
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      term.dispose();
      searchRef.current = null;
      serializeRef.current = null;
      termRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, generation]);

  // Preferences apply live to the running terminal — no reopen needed.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, monoFontSize + zoomRef.current));
    term.options.fontFamily = terminalFontStack(fontFamily);
    term.options.lineHeight = lineHeight;
    term.options.cursorBlink = cursorBlink;
    term.options.cursorStyle = cursorStyle;
    term.options.scrollback = scrollback;
    term.options.theme = scheme.theme;
    fitRef.current?.fit();
  }, [monoFontSize, fontFamily, lineHeight, cursorBlink, cursorStyle, scrollback, scheme, generation]);

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
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [active]);

  const answerAuth = (answers: string[] | null) => {
    setAuthPrompt(null);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (answers === null) ws.close();
    else ws.send(JSON.stringify({ op: 'auth-response', answers }));
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
        onContextMenu={onContextMenu}
        sx={{
          height: '100%',
          bgcolor: scheme.theme.background,
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
      {status === 'closed' && (
        <Stack
          spacing={1.5}
          sx={{
            position: 'absolute',
            top: theme.spacing(0.75),
            right: theme.spacing(1),
            bottom: theme.spacing(1),
            left: theme.spacing(1),
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'rgba(22, 22, 30, 0.72)',
            borderRadius: 1,
          }}
        >
          <Typography variant="body2" sx={{ color: '#c8ccd8' }}>
            Session ended
          </Typography>
          <Button
            variant="contained"
            size="small"
            onClick={() => setGeneration((current) => (current < 0 ? 0 : current + 1))}
          >
            Reconnect
          </Button>
        </Stack>
      )}
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
          disabled={!ctxMenu?.hasSelection}
          onClick={() => {
            const term = termRef.current;
            if (term?.hasSelection()) {
              void copyToClipboard(term.getSelection()).then((ok) => {
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
      <PasteConfirmDialog
        text={pendingPaste}
        onCancel={() => setPendingPaste(null)}
        onConfirm={(text) => {
          setPendingPaste(null);
          termRef.current?.paste(text);
          termRef.current?.focus();
        }}
      />
    </Box>
  );
}
