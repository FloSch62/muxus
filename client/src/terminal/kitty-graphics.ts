import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { parseGraphicsControl, type GraphicsCommand } from './apc-stream.js';

/**
 * Kitty graphics protocol engine (https://sw.kovidgoyal.net/kitty/graphics-protocol/).
 *
 * Supported: direct (t=d) transmission of PNG / RGB / RGBA, optionally
 * zlib-compressed (o=z) and chunked (m=1); transmit (a=t), transmit-and-
 * display (a=T), put (a=p), query (a=q) and the common delete (a=d) forms;
 * placement geometry (x,y,w,h source rect, c,r cell sizing, X,Y offsets,
 * z-index, C=1 cursor policy). Not supported (answered with an error so
 * clients fall back): file/shared-memory transmission, animation frames,
 * Unicode placeholders.
 *
 * Rendering: each placement is a <canvas> in an overlay layer inside xterm's
 * screen element, anchored to a buffer marker so images scroll with the text
 * they were printed next to. z >= 0 renders above text; z < 0 in a layer
 * under the text canvas (visible wherever cells keep the default background).
 */

export interface GraphicsResult {
  /** Protocol response to send back to the application (over stdin), if any. */
  response?: string;
  /** Escape sequence to write into the terminal to advance the cursor. */
  advance?: string;
}

interface StoredImage {
  id: number;
  number?: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  bytes: number;
  lastUsed: number;
}

interface Placement {
  key: string;
  imageId: number;
  placementId: number;
  screen: 'normal' | 'alternate';
  marker?: IMarker;
  /** Absolute buffer row fallback when no marker is available. */
  row: number;
  col: number;
  cols: number;
  rows: number;
  z: number;
  /** CSS-pixel offset within the anchor cell (protocol X/Y keys). */
  offX: number;
  offY: number;
  el: HTMLCanvasElement;
}

/** Decoded-pixel budget across all stored images (LRU-evicted). */
const MAX_STORED_BYTES = 256 * 1024 * 1024;
const MAX_TRANSMISSION_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_DIM = 10_000;
const MAX_PLACEMENTS = 512;

export class KittyGraphicsEngine {
  private readonly images = new Map<number, StoredImage>();
  private readonly placements = new Map<string, Placement>();
  /** In-flight chunked transmission (kitty allows at most one at a time). */
  private pending: { ctl: Map<string, string>; chunks: string[]; size: number } | undefined;
  private underLayer: HTMLDivElement | undefined;
  private overLayer: HTMLDivElement | undefined;
  private screenEl: HTMLElement | undefined;
  private readonly disposables: IDisposable[] = [];
  private nextAutoId = 0x7f000000;
  private nextAnonId = -1;
  private tick = 0;

  constructor(private readonly term: Terminal) {}

  /** Hook the overlay layers and repaint triggers into an opened terminal. */
  attach(): void {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;
    this.screenEl = screen;
    this.underLayer = makeLayer();
    this.overLayer = makeLayer();
    // DOM order does the stacking: under-layer before the text canvases,
    // over-layer after them.
    screen.insertBefore(this.underLayer, screen.firstChild);
    screen.appendChild(this.overLayer);

    this.disposables.push(
      this.term.onRender(() => this.position()),
      this.term.onResize(() => this.position()),
      this.term.buffer.onBufferChange(() => {
        // Leaving the alt screen discards its images, matching kitty.
        if (this.term.buffer.active.type === 'normal') this.deleteWhere((p) => p.screen === 'alternate', true);
        this.position();
      }),
      // ED 2/3 wipes the screen — drop placements on the active screen so
      // `clear` behaves like kitty. Return false: xterm still processes it.
      this.term.parser.registerCsiHandler({ final: 'J' }, (params) => {
        const mode = typeof params[0] === 'number' ? params[0] : 0;
        if (mode === 2 || mode === 3) this.deleteWhere((p) => p.screen === this.term.buffer.active.type, false);
        return false;
      }),
      this.term.parser.registerEscHandler({ final: 'c' }, () => {
        this.reset();
        return false;
      }),
    );
  }

  dispose(): void {
    this.reset();
    for (const d of this.disposables) d.dispose();
    this.underLayer?.remove();
    this.overLayer?.remove();
  }

  reset(): void {
    for (const p of this.placements.values()) this.dropPlacement(p);
    this.placements.clear();
    for (const img of this.images.values()) img.bitmap.close();
    this.images.clear();
    this.pending = undefined;
  }

  async handle(cmd: GraphicsCommand): Promise<GraphicsResult> {
    let ctl = parseGraphicsControl(cmd.control);
    let payload = cmd.payload;

    // Chunked transmission: the first escape carries the full control data
    // plus m=1; continuations carry only m until the final m=0.
    if (this.pending) {
      this.pending.chunks.push(payload);
      this.pending.size += payload.length;
      if (this.pending.size > MAX_TRANSMISSION_BYTES) {
        const failed = this.pending.ctl;
        this.pending = undefined;
        return this.errorFor(failed, 'EFBIG:transmission too large');
      }
      if (ctl.get('m') === '1') return {};
      ctl = this.pending.ctl;
      payload = this.pending.chunks.join('');
      this.pending = undefined;
    } else if (ctl.get('m') === '1') {
      this.pending = { ctl, chunks: [payload], size: payload.length };
      return {};
    }

    const action = ctl.get('a') ?? 't';
    switch (action) {
      case 'q':
        return this.query(ctl, payload);
      case 't':
      case 'T':
        return this.transmit(ctl, payload, action === 'T');
      case 'p':
        return this.put(ctl);
      case 'd':
        this.delete(ctl);
        return {};
      default:
        return this.errorFor(ctl, `EINVAL:action ${action} not supported`);
    }
  }

  // ---- protocol actions ----------------------------------------------------

  private async query(ctl: Map<string, string>, payload: string): Promise<GraphicsResult> {
    const invalid = validateTransmission(ctl);
    if (invalid) return this.respond(ctl, invalid, true);
    try {
      const decoded = await decodeImage(ctl, payload);
      decoded.bitmap.close();
      return this.respond(ctl, 'OK', true);
    } catch (err) {
      return this.respond(ctl, errorMessage(err), true);
    }
  }

  private async transmit(ctl: Map<string, string>, payload: string, display: boolean): Promise<GraphicsResult> {
    const invalid = validateTransmission(ctl);
    if (invalid) return this.errorFor(ctl, invalid);
    let bitmap: ImageBitmap;
    let width: number;
    let height: number;
    try {
      ({ bitmap, width, height } = await decodeImage(ctl, payload));
    } catch (err) {
      return this.errorFor(ctl, errorMessage(err));
    }

    const requestedId = intKey(ctl, 'i');
    const number = intKey(ctl, 'I');
    const id = requestedId ?? (number !== undefined ? this.nextAutoId++ : this.nextAnonId--);
    this.images.get(id)?.bitmap.close();
    this.images.set(id, { id, number, bitmap, width, height, bytes: width * height * 4, lastUsed: ++this.tick });
    this.evictOverBudget();

    const result: GraphicsResult = display ? this.place(this.images.get(id)!, ctl) : {};
    // Transmissions are only acknowledged when the client identified them.
    if (requestedId !== undefined || number !== undefined) {
      const ack = this.respond(ctl, 'OK', false, id);
      result.response = ack.response;
    }
    return result;
  }

  private put(ctl: Map<string, string>): GraphicsResult {
    const image = this.findImage(ctl);
    if (!image) return this.errorFor(ctl, 'ENOENT:image not found');
    image.lastUsed = ++this.tick;
    const result = this.place(image, ctl);
    const ack = this.respond(ctl, 'OK', false, image.id);
    result.response = ack.response;
    return result;
  }

  // ---- placement -----------------------------------------------------------

  private place(image: StoredImage, ctl: Map<string, string>): GraphicsResult {
    if (ctl.get('U') === '1') return this.errorFor(ctl, 'EINVAL:unicode placeholders not supported');
    const cell = this.cellSize();
    const dpr = window.devicePixelRatio || 1;
    const cellPxW = cell.w * dpr;
    const cellPxH = cell.h * dpr;

    // Source rectangle within the image.
    const sx = clamp(intKey(ctl, 'x') ?? 0, 0, image.width);
    const sy = clamp(intKey(ctl, 'y') ?? 0, 0, image.height);
    const sw = clamp(intKey(ctl, 'w') || image.width - sx, 1, image.width - sx);
    const sh = clamp(intKey(ctl, 'h') || image.height - sy, 1, image.height - sy);

    // Display size: c/r stretch to the cell box; a single one preserves
    // aspect; neither renders at natural device-pixel size.
    const c = intKey(ctl, 'c');
    const r = intKey(ctl, 'r');
    let drawW: number;
    let drawH: number;
    if (c && r) {
      drawW = c * cellPxW;
      drawH = r * cellPxH;
    } else if (c) {
      drawW = c * cellPxW;
      drawH = (sh * drawW) / sw;
    } else if (r) {
      drawH = r * cellPxH;
      drawW = (sw * drawH) / sh;
    } else {
      drawW = sw;
      drawH = sh;
    }
    const cols = Math.max(1, Math.ceil(drawW / cellPxW));
    const rows = Math.max(1, Math.ceil(drawH / cellPxH));
    const offX = clamp(intKey(ctl, 'X') ?? 0, 0, Math.max(0, cellPxW - 1));
    const offY = clamp(intKey(ctl, 'Y') ?? 0, 0, Math.max(0, cellPxH - 1));

    const buffer = this.term.buffer.active;
    const col = buffer.cursorX;
    const row = buffer.baseY + buffer.cursorY;
    const marker = this.term.registerMarker(0) ?? undefined;
    const z = intKey(ctl, 'z') ?? 0;
    const placementId = intKey(ctl, 'p') ?? 0;
    const key = `${image.id}:${placementId}`;
    const existing = this.placements.get(key);
    if (existing) this.dropPlacement(existing);

    const el = document.createElement('canvas');
    el.width = Math.max(1, Math.round(drawW));
    el.height = Math.max(1, Math.round(drawH));
    el.style.position = 'absolute';
    el.style.width = `${drawW / dpr}px`;
    el.style.height = `${drawH / dpr}px`;
    el.style.display = 'none';
    el.style.zIndex = String(z);
    el.getContext('2d')?.drawImage(image.bitmap, sx, sy, sw, sh, 0, 0, el.width, el.height);
    (z < 0 ? this.underLayer : this.overLayer)?.appendChild(el);

    const placement: Placement = {
      key,
      imageId: image.id,
      placementId,
      screen: buffer.type,
      marker,
      row,
      col,
      cols,
      rows,
      z,
      offX: offX / dpr,
      offY: offY / dpr,
      el,
    };
    this.placements.set(key, placement);
    if (this.placements.size > MAX_PLACEMENTS) {
      const oldest = this.placements.values().next().value;
      if (oldest) this.deletePlacement(oldest);
    }
    this.position();

    // Kitty leaves the cursor on the image's bottom row, one cell right of
    // it. IND (ESC D) keeps the column and scrolls at the bottom like text.
    const advance = ctl.get('C') === '1' ? undefined : '\x1bD'.repeat(rows - 1) + `\x1b[${col + cols + 1}G`;
    return { advance };
  }

  private position(): void {
    if (!this.screenEl) return;
    const active = this.term.buffer.active;
    const cell = this.cellSize();
    // Deleting the entry under the cursor is well-defined for Map iteration.
    for (const p of this.placements.values()) {
      if (p.marker && p.marker.line === -1) {
        // Line trimmed out of scrollback — the image is gone for good.
        this.deletePlacement(p);
        continue;
      }
      if (p.screen !== active.type) {
        p.el.style.display = 'none';
        continue;
      }
      const line = p.marker ? p.marker.line : p.row;
      const top = (line - active.viewportY) * cell.h + p.offY;
      if (top + p.rows * cell.h <= 0 || top >= this.term.rows * cell.h) {
        p.el.style.display = 'none';
        continue;
      }
      p.el.style.display = 'block';
      p.el.style.left = `${p.col * cell.w + p.offX}px`;
      p.el.style.top = `${top}px`;
    }
  }

  // ---- deletes -------------------------------------------------------------

  private delete(ctl: Map<string, string>): void {
    const what = ctl.get('d') ?? 'a';
    const freeData = what !== what.toLowerCase();
    const buffer = this.term.buffer.active;
    switch (what.toLowerCase()) {
      case 'a':
        this.deleteWhere((p) => p.screen === buffer.type, freeData);
        break;
      case 'i': {
        const id = intKey(ctl, 'i');
        const placementId = intKey(ctl, 'p');
        if (id === undefined) return;
        this.deleteWhere((p) => p.imageId === id && (placementId === undefined || p.placementId === placementId), freeData);
        if (freeData) this.freeImage(id);
        break;
      }
      case 'n': {
        const image = this.findImage(ctl);
        if (!image) return;
        this.deleteWhere((p) => p.imageId === image.id, freeData);
        if (freeData) this.freeImage(image.id);
        break;
      }
      case 'c': {
        const col = buffer.cursorX;
        const row = buffer.baseY + buffer.cursorY;
        this.deleteWhere((p) => this.intersectsCell(p, col, row), freeData);
        break;
      }
      case 'p': {
        const col = (intKey(ctl, 'x') ?? 1) - 1;
        const row = buffer.baseY + (intKey(ctl, 'y') ?? 1) - 1;
        this.deleteWhere((p) => this.intersectsCell(p, col, row), freeData);
        break;
      }
      case 'z': {
        const z = intKey(ctl, 'z');
        if (z === undefined) return;
        this.deleteWhere((p) => p.z === z, freeData);
        break;
      }
      default:
        break;
    }
  }

  private intersectsCell(p: Placement, col: number, row: number): boolean {
    const line = p.marker ? p.marker.line : p.row;
    return col >= p.col && col < p.col + p.cols && row >= line && row < line + p.rows;
  }

  private deleteWhere(match: (p: Placement) => boolean, freeData: boolean): void {
    const touched = new Set<number>();
    // Deleting the entry under the cursor is well-defined for Map iteration.
    for (const p of this.placements.values()) {
      if (!match(p)) continue;
      this.deletePlacement(p);
      touched.add(p.imageId);
    }
    if (freeData) {
      for (const id of touched) this.freeImage(id);
    }
  }

  private freeImage(id: number): void {
    if ([...this.placements.values()].some((p) => p.imageId === id)) return;
    const image = this.images.get(id);
    if (image) {
      image.bitmap.close();
      this.images.delete(id);
    }
  }

  private deletePlacement(p: Placement): void {
    this.dropPlacement(p);
    this.placements.delete(p.key);
  }

  private dropPlacement(p: Placement): void {
    p.el.remove();
    p.marker?.dispose();
  }

  private evictOverBudget(): void {
    let total = 0;
    for (const img of this.images.values()) total += img.bytes;
    if (total <= MAX_STORED_BYTES) return;
    const byAge = [...this.images.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const img of byAge) {
      if (total <= MAX_STORED_BYTES) break;
      this.deleteWhere((p) => p.imageId === img.id, false);
      img.bitmap.close();
      this.images.delete(img.id);
      total -= img.bytes;
    }
  }

  // ---- helpers -------------------------------------------------------------

  private findImage(ctl: Map<string, string>): StoredImage | undefined {
    const id = intKey(ctl, 'i');
    if (id !== undefined) return this.images.get(id);
    const number = intKey(ctl, 'I');
    if (number === undefined) return undefined;
    // Newest image with this number wins, per spec.
    let found: StoredImage | undefined;
    for (const img of this.images.values()) {
      if (img.number === number && (!found || img.lastUsed > found.lastUsed)) found = img;
    }
    return found;
  }

  private respond(ctl: Map<string, string>, message: string, isQuery: boolean, allocatedId?: number): GraphicsResult {
    const quiet = intKey(ctl, 'q') ?? 0;
    const isError = message !== 'OK';
    if (isError && quiet >= 2) return {};
    if (!isError && quiet >= 1) return {};
    const keys: string[] = [];
    const id = intKey(ctl, 'i') ?? allocatedId;
    const number = intKey(ctl, 'I');
    if (id !== undefined) keys.push(`i=${id}`);
    if (number !== undefined) keys.push(`I=${number}`);
    if (!keys.length && !isQuery) return {};
    return { response: `\x1b_G${keys.join(',')};${message}\x1b\\` };
  }

  private errorFor(ctl: Map<string, string>, message: string): GraphicsResult {
    return this.respond(ctl, message, false);
  }

  private cellSize(): { w: number; h: number } {
    // The renderer's own cell metrics are exact; fall back to measuring.
    const core = (this.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core;
    const dims = core?._renderService?.dimensions?.css?.cell;
    if (dims?.width && dims?.height) return { w: dims.width, h: dims.height };
    if (this.screenEl && this.term.cols && this.term.rows) {
      return { w: this.screenEl.clientWidth / this.term.cols, h: this.screenEl.clientHeight / this.term.rows };
    }
    return { w: 9, h: 17 };
  }
}

function makeLayer(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.position = 'absolute';
  el.style.inset = '0';
  el.style.overflow = 'hidden';
  el.style.pointerEvents = 'none';
  return el;
}

function validateTransmission(ctl: Map<string, string>): string | undefined {
  const medium = ctl.get('t') ?? 'd';
  if (medium !== 'd') return 'EINVAL:only direct transmission is supported';
  const format = ctl.get('f') ?? '32';
  if (format !== '24' && format !== '32' && format !== '100') return `EINVAL:unsupported format ${format}`;
  const compression = ctl.get('o');
  if (compression && compression !== 'z') return `EINVAL:unsupported compression ${compression}`;
  if (format !== '100') {
    const s = intKey(ctl, 's');
    const v = intKey(ctl, 'v');
    if (!s || !v) return 'EINVAL:raw formats need s and v';
    if (s > MAX_IMAGE_DIM || v > MAX_IMAGE_DIM) return 'EFBIG:image too large';
  }
  return undefined;
}

async function decodeImage(ctl: Map<string, string>, payload: string): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  let bytes = base64Decode(payload);
  if (ctl.get('o') === 'z') bytes = await inflate(bytes);
  const format = ctl.get('f') ?? '32';

  if (format === '100') {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' }));
    } catch {
      throw new Error('EBADPNG:could not decode PNG');
    }
    if (bitmap.width > MAX_IMAGE_DIM || bitmap.height > MAX_IMAGE_DIM) {
      bitmap.close();
      throw new Error('EFBIG:image too large');
    }
    return { bitmap, width: bitmap.width, height: bitmap.height };
  }

  const width = intKey(ctl, 's')!;
  const height = intKey(ctl, 'v')!;
  const channels = format === '24' ? 3 : 4;
  if (bytes.length < width * height * channels) throw new Error('ENODATA:pixel data shorter than s×v');
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (channels === 4) {
    rgba.set(bytes.subarray(0, width * height * 4));
  } else {
    for (let i = 0, j = 0; j < width * height * 4; i += 3, j += 4) {
      rgba[j] = bytes[i]!;
      rgba[j + 1] = bytes[i + 1]!;
      rgba[j + 2] = bytes[i + 2]!;
      rgba[j + 3] = 255;
    }
  }
  const bitmap = await createImageBitmap(new ImageData(rgba, width, height));
  return { bitmap, width, height };
}

function base64Decode(payload: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(payload.replace(/\s+/g, ''));
  } catch {
    throw new Error('EINVAL:invalid base64 payload');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    // o=z is RFC 1950 zlib — DecompressionStream's 'deflate'.
    const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error('EINVAL:could not inflate payload');
  }
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return /^E[A-Z]+:/.test(msg) ? msg : `EINVAL:${msg}`;
}

function intKey(ctl: Map<string, string>, key: string): number | undefined {
  const raw = ctl.get(key);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
