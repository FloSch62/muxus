import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalServerMessage } from '@muxus/shared';
import { wsUrl } from '../api/http.js';
import { copyToClipboard, readFromClipboard } from '../clipboard.js';
import { showToast } from '../state/toast.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore, type TerminalTab } from '../state/tabs.js';
import { KittyApcExtractor, type StreamPart } from '../terminal/apc-stream.js';
import { KittyGraphicsEngine } from '../terminal/kitty-graphics.js';
import { KittyKeyboardHandler } from '../terminal/kitty-keyboard.js';
import { terminalTheme, TERMINAL_BACKGROUND } from '../terminal/palette.js';
import { AuthPromptDialog, type AuthPromptRequest } from './AuthPromptDialog.js';
import { HostKeyDialog, type HostKeyRequest } from './HostKeyDialog.js';

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

export default function TerminalViewImpl({ tab, active }: { tab: TerminalTab; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const theme = useTheme();
  const [authPrompt, setAuthPrompt] = useState<AuthPromptRequest | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyRequest | null>(null);
  const [generation, setGeneration] = useState(0);
  const updateTab = useTabsStore((s) => s.update);
  const status = useTabsStore((s) => s.tabs.find((t) => t.id === tab.id)?.status);

  // Right-click copies the selection when there is one, otherwise pastes —
  // the common terminal-emulator convention. Paste goes through term.paste()
  // so bracketed-paste mode reaches the remote shell intact.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (selection) {
      void copyToClipboard(selection).then((ok) => {
        if (ok) term.clearSelection();
      });
      return;
    }
    void readFromClipboard().then((text) => {
      if (text === null) {
        showToast('warning', 'Clipboard read unavailable or denied — allow clipboard access, or paste with the keyboard.');
        return;
      }
      if (text) term.paste(text);
    });
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    updateTab(tab.id, { status: 'connecting' });

    const { monoFontSize, scrollback, cursorBlink, cursorStyle, copyOnSelect } = usePrefsStore.getState();
    const term = new Terminal({
      fontSize: monoFontSize + 1,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      cursorBlink,
      cursorStyle,
      scrollback,
      allowProposedApi: true,
      theme: terminalTheme,
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
    term.open(el);
    fit.fit();

    const encoder = new TextEncoder();
    const sendToApp = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    };

    const graphics = new KittyGraphicsEngine(term);
    graphics.attach();
    const keyboard = new KittyKeyboardHandler(term);
    keyboard.attach();
    const extractor = new KittyApcExtractor();
    const pipeline = new GraphicsPipeline(term, graphics, sendToApp);

    term.attachCustomKeyEventHandler((ev) => {
      // Ctrl+Shift+C/V/T stay ours (kitty reserves ctrl+shift for the terminal).
      if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
        if (ev.code === 'KeyC' && term.hasSelection()) {
          void copyToClipboard(term.getSelection());
          return false;
        }
        if (ev.code === 'KeyV') {
          void readFromClipboard().then((text) => {
            if (text) term.paste(text);
          });
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
      if (copyOnSelect && term.hasSelection()) void copyToClipboard(term.getSelection());
    });

    const ws = new WebSocket(wsUrl('/ws/terminal'));
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
          setAuthPrompt({ name: ctl.name, instructions: ctl.instructions, prompts: ctl.prompts });
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
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    const onBinary = term.onBinary((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      ws.send(bytes);
    });
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'resize', cols, rows }));
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    return () => {
      observer.disconnect();
      onData.dispose();
      onBinary.dispose();
      onResize.dispose();
      onSelection.dispose();
      keyboard.dispose();
      graphics.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, generation]);

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

  return (
    <Box sx={{ height: '100%', p: 1, pt: 0.75, position: 'relative' }}>
      <Box
        ref={containerRef}
        onContextMenu={onContextMenu}
        sx={{
          height: '100%',
          bgcolor: TERMINAL_BACKGROUND,
          border: 1,
          borderColor: theme.palette.mode === 'dark' ? 'transparent' : theme.palette.divider,
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
            inset: 8,
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'rgba(22, 22, 30, 0.72)',
            borderRadius: 1,
          }}
        >
          <Typography variant="body2" sx={{ color: '#c8ccd8' }}>
            Session ended
          </Typography>
          <Button variant="contained" size="small" onClick={() => setGeneration((g) => g + 1)}>
            Reconnect
          </Button>
        </Stack>
      )}
      <AuthPromptDialog request={authPrompt} onSubmit={answerAuth} />
      <HostKeyDialog request={hostKey} onAnswer={answerHostKey} />
    </Box>
  );
}
