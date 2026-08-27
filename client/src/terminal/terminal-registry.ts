/**
 * Imperative handles for mounted terminals, keyed by tab id. UI outside the
 * terminal component (TopBar menu, tab context menus) acts on the active
 * terminal through its handle; the component registers on mount and
 * unregisters on dispose.
 */
export interface TerminalAnchorPosition {
  top: number;
  left: number;
}

export interface TerminalHandle {
  focus(): void;
  /** Viewport position immediately below the terminal cursor. */
  cursorAnchorPosition(): TerminalAnchorPosition | undefined;
  /** Write raw input directly to this terminal's PTY transport. */
  sendInput(data: string | Uint8Array<ArrayBuffer>): boolean;
  /** Clear screen + scrollback. */
  clear(): void;
  selectAll(): void;
  hasSelection(): boolean;
  getSelection(): string;
  /** Plain-text scrollback + screen contents. */
  bufferText(): string;
  /** Standalone HTML document of the buffer with colors preserved. */
  bufferHtml(): string;
  /** Persist the latest screen + scrollback before handing this tab to another window. */
  persistSnapshot(): Promise<void>;
  /** Freeze server output and drain xterm's write queue before taking that snapshot. */
  prepareTransfer(): Promise<boolean>;
  /** Resume server output when a prepared transfer is abandoned. */
  cancelTransfer(): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  /** Current zoom as a percentage (100 = preference font size). */
  zoomPercent(): number;
  paste(text: string): void;
  /** Read and paste the current clipboard, including SSH image uploads. */
  pasteClipboard(): void;
  /** Start/stop/pause persistence or change input capture for this live session. */
  setLogging(patch: {
    enabled?: boolean;
    paused?: boolean;
    captureInput?: boolean;
  }): boolean;
}

const handles = new Map<string, TerminalHandle>();

export function registerTerminal(tabId: string, handle: TerminalHandle): () => void {
  handles.set(tabId, handle);
  return () => {
    if (handles.get(tabId) === handle) handles.delete(tabId);
  };
}

export function terminalHandle(tabId: string | null | undefined): TerminalHandle | undefined {
  return tabId ? handles.get(tabId) : undefined;
}
