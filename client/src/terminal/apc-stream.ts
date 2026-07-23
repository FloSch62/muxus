/**
 * Splits a terminal byte stream into plain data and kitty graphics commands.
 *
 * xterm.js has no APC hooks (its parser silently discards APC strings), so
 * the graphics protocol — which rides on `ESC _ G <control>;<payload> ESC \`
 * — is extracted *before* the stream reaches term.write(). That is also the
 * fast path: megabyte base64 image payloads never churn through the terminal
 * parser. Everything that is not a kitty APC passes through byte-identical,
 * including other APC strings (xterm consumes and ignores those itself).
 */

export interface GraphicsCommand {
  /** Raw control data — the `k=v,k=v` part before the first `;`. */
  control: string;
  /** Raw base64 payload after the first `;` (may be empty). */
  payload: string;
}

export type StreamPart = { kind: 'data'; data: Uint8Array } | { kind: 'gfx'; cmd: GraphicsCommand };

const ESC = 0x1b;
const UNDERSCORE = 0x5f;
const G = 0x47;
const BACKSLASH = 0x5c;

/** Cap a single APC accumulation — a stream that never terminates its APC
 *  must not buffer unboundedly. Kitty chunks payloads at 4096 bytes; this
 *  allows generous single-escape payloads while bounding memory. */
const MAX_APC_BYTES = 8 * 1024 * 1024;

type State = 'text' | 'esc' | 'apc-intro' | 'apc' | 'apc-esc' | 'other-apc' | 'other-apc-esc';

export class KittyApcExtractor {
  private state: State = 'text';
  private apcBuf: number[] = [];
  private overflow = false;

  /** Feed a chunk; returns ordered parts. APCs split across chunks are held. */
  feed(chunk: Uint8Array): StreamPart[] {
    const parts: StreamPart[] = [];
    let dataStart = -1; // start of the current passthrough run in `chunk`
    const flushData = (end: number) => {
      if (dataStart >= 0 && end > dataStart) parts.push({ kind: 'data', data: chunk.subarray(dataStart, end) });
      dataStart = -1;
    };
    const emitBytes = (bytes: number[]) => {
      if (bytes.length) parts.push({ kind: 'data', data: Uint8Array.from(bytes) });
    };

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      switch (this.state) {
        case 'text':
          if (b === ESC) {
            flushData(i);
            this.state = 'esc';
          } else if (dataStart < 0) {
            dataStart = i;
          }
          break;
        case 'esc':
          if (b === UNDERSCORE) {
            this.state = 'apc-intro';
          } else if (b === ESC) {
            emitBytes([ESC]); // previous ESC belongs to the output
          } else {
            emitBytes([ESC]);
            this.state = 'text';
            dataStart = i; // current byte is plain data
          }
          break;
        case 'apc-intro':
          if (b === G) {
            this.state = 'apc';
            this.apcBuf = [];
            this.overflow = false;
          } else {
            // Non-kitty APC: replay the intro and pass it through untouched
            // until its ST so its content can't be misread as ours.
            emitBytes([ESC, UNDERSCORE]);
            this.state = b === ESC ? 'other-apc-esc' : 'other-apc';
            dataStart = i;
          }
          break;
        case 'apc':
          if (b === ESC) {
            this.state = 'apc-esc';
          } else if (this.overflow) {
            /* discard */
          } else if (this.apcBuf.length >= MAX_APC_BYTES) {
            this.overflow = true;
            this.apcBuf = [];
          } else {
            this.apcBuf.push(b);
          }
          break;
        case 'apc-esc':
          if (b === BACKSLASH) {
            if (!this.overflow) parts.push({ kind: 'gfx', cmd: splitApc(this.apcBuf) });
            this.apcBuf = [];
            this.state = 'text';
          } else {
            // Stray ESC inside an APC (spec-invalid): keep it as content.
            if (!this.overflow) this.apcBuf.push(ESC, b);
            this.state = 'apc';
          }
          break;
        case 'other-apc':
          if (b === ESC) this.state = 'other-apc-esc';
          if (dataStart < 0) dataStart = i;
          break;
        case 'other-apc-esc':
          this.state = b === BACKSLASH ? 'text' : b === ESC ? 'other-apc-esc' : 'other-apc';
          if (dataStart < 0) dataStart = i;
          break;
      }
    }
    flushData(chunk.length);
    return parts;
  }
}

function splitApc(bytes: number[]): GraphicsCommand {
  const semi = bytes.indexOf(0x3b);
  const controlBytes = semi < 0 ? bytes : bytes.slice(0, semi);
  const payloadBytes = semi < 0 ? [] : bytes.slice(semi + 1);
  return {
    control: String.fromCharCode(...controlBytes),
    payload: payloadFromBytes(payloadBytes),
  };
}

/** Payloads are base64 (ASCII) — but can be huge; chunk the conversion so we
 *  never blow the argument-count limit of String.fromCharCode. */
function payloadFromBytes(bytes: number[]): string {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.slice(i, i + CHUNK));
  }
  return out;
}

/** Parse `k=v,k=v` graphics control data. Unknown keys are preserved. */
export function parseGraphicsControl(control: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!control) return out;
  for (const pair of control.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}
