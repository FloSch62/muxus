import type { HostKeywordHighlightConfig, KeywordHighlightRule } from '@muxus/shared';
import type { IBufferLine, IDecoration, IDisposable, Terminal } from '@xterm/xterm';
import { KeywordMatchRetry, keywordMatchClient, type KeywordMatchClient } from './keyword-match-client.js';
import {
  groupKeywordMatches,
  isSlowKeywordPattern,
  matchKeywordLines,
  type KeywordMatch,
  type KeywordMatcher,
} from './keyword-matching.js';

/** Resolve the effective rules for a local/ad-hoc terminal or one saved host. */
export function resolveKeywordHighlights(
  globalRules: readonly KeywordHighlightRule[],
  hostConfig?: HostKeywordHighlightConfig,
  profileRules: readonly KeywordHighlightRule[] = [],
): KeywordHighlightRule[] {
  if (!hostConfig) return [...globalRules];
  return hostConfig.inheritGlobal
    ? [...globalRules, ...profileRules, ...hostConfig.rules]
    : [...profileRules, ...hostConfig.rules];
}

interface CellSegment {
  textStart: number;
  textEnd: number;
  cellStart: number;
  cellEnd: number;
}

function lineTextAndCells(
  line: IBufferLine,
  maxColumns: number,
): { text: string; segments: CellSegment[] } {
  let text = '';
  const segments: CellSegment[] = [];
  for (let column = 0; column < Math.min(line.length, maxColumns); column++) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    const textStart = text.length;
    text += chars;
    segments.push({
      textStart,
      textEnd: text.length,
      cellStart: column,
      cellEnd: column + Math.max(1, cell.getWidth()),
    });
  }
  return { text: text.trimEnd(), segments };
}

function cellsForMatch(
  segments: readonly CellSegment[],
  start: number,
  end: number,
): { x: number; width: number } | undefined {
  const first = segments.find((segment) => start < segment.textEnd);
  let last: CellSegment | undefined;
  for (const segment of segments) {
    if (segment.textStart >= end) break;
    last = segment;
  }
  if (!first || !last) return undefined;
  return { x: first.cellStart, width: last.cellEnd - first.cellStart };
}

export interface KeywordHighlighter extends IDisposable {
  setRules(rules: readonly KeywordHighlightRule[]): void;
}

interface LineSnapshot {
  lineIndex: number;
  text: string;
  segments: CellSegment[];
}

function matcherFields(rule: KeywordHighlightRule): KeywordMatcher {
  return {
    keyword: rule.keyword,
    caseSensitive: rule.caseSensitive,
    wholeWord: rule.wholeWord,
    regex: rule.regex,
  };
}

/**
 * Highlight the visible viewport with tracked xterm decorations. Scanning is
 * frame-batched by onWriteParsed and repeated on scroll, so scrollback remains
 * correct without doing O(scrollback) work for every chunk of PTY output.
 *
 * Literal keywords are matched here, in the frame. Once a rule is a regex the
 * whole set is matched by the shared worker instead, because a pattern that
 * backtracks catastrophically would otherwise freeze the UI thread; the old
 * decorations stay until the worker answers, so nothing flickers.
 */
export function attachKeywordHighlighter(
  terminal: Terminal,
  initialRules: readonly KeywordHighlightRule[],
  matcher: () => KeywordMatchClient = keywordMatchClient,
): KeywordHighlighter {
  let rules = [...initialRules];
  let rulesVersion = 0;
  let decorations: IDecoration[] = [];
  let disposed = false;
  let scheduled = false;
  // One worker request per terminal at a time; frames that arrive meanwhile
  // collapse into a single render when it answers.
  let waiting = false;
  let renderAgain = false;

  const clear = () => {
    for (const decoration of decorations) {
      decoration.dispose();
      decoration.marker.dispose();
    }
    decorations = [];
  };

  const visibleLines = (): LineSnapshot[] | undefined => {
    const buffer = terminal.buffer.active;
    // xterm cannot anchor decorations in the alternate buffer used by full-screen apps.
    if (buffer.type === 'alternate') return undefined;
    const lines: LineSnapshot[] = [];
    const viewportEnd = Math.min(buffer.length, buffer.viewportY + terminal.rows);
    for (let lineIndex = buffer.viewportY; lineIndex < viewportEnd; lineIndex++) {
      const line = buffer.getLine(lineIndex);
      if (line) lines.push({ lineIndex, ...lineTextAndCells(line, terminal.cols) });
    }
    return lines;
  };

  const decorate = (
    lines: readonly LineSnapshot[],
    matches: readonly KeywordMatch[][],
    verifyText: boolean,
  ) => {
    clear();
    const buffer = terminal.buffer.active;
    if (buffer.type === 'alternate') return;
    lines.forEach((snapshot, index) => {
      const lineMatches = matches[index];
      if (!lineMatches?.length) return;
      if (verifyText) {
        // Output may have rewritten this line while the worker was matching;
        // the render that output scheduled covers the new text.
        const line = buffer.getLine(snapshot.lineIndex);
        if (!line || lineTextAndCells(line, terminal.cols).text !== snapshot.text) return;
      }
      for (const match of lineMatches) {
        const range = cellsForMatch(snapshot.segments, match.start, match.end);
        if (!range) continue;
        const marker = terminal.registerMarker(
          snapshot.lineIndex - (buffer.baseY + buffer.cursorY),
        );
        if (!marker) continue;
        const decoration = terminal.registerDecoration({
          marker,
          x: range.x,
          width: range.width,
          foregroundColor: match.rule.foreground,
          backgroundColor: match.rule.background,
          layer: 'bottom',
        });
        if (decoration) decorations.push(decoration);
        else marker.dispose();
      }
    });
  };

  const render = () => {
    scheduled = false;
    if (disposed) return;
    if (waiting) {
      renderAgain = true;
      return;
    }
    const client = matcher();
    const active = rules.filter(
      (rule) => rule.keyword && !(rule.regex && (!client.available || isSlowKeywordPattern(rule))),
    );
    const lines = active.length > 0 ? visibleLines() : undefined;
    if (!lines) {
      clear();
      return;
    }
    const texts = lines.map((line) => line.text);
    const matchers = active.map(matcherFields);
    if (!active.some((rule) => rule.regex)) {
      // Literal matching is linear, so it stays in this frame.
      const flat = matchKeywordLines(matchers, texts);
      decorate(lines, groupKeywordMatches(flat, active, lines.length), false);
      return;
    }
    waiting = true;
    const version = rulesVersion;
    client
      .match(matchers, texts)
      .then(
        (flat) => {
          if (disposed || version !== rulesVersion) return;
          decorate(lines, groupKeywordMatches(flat, active, lines.length), true);
        },
        (error: unknown) => {
          // A retry follows a paused slow pattern or a replaced worker; any
          // other failure means the worker is unavailable and regex rules drop.
          if (!(error instanceof KeywordMatchRetry) && client.available) {
            console.warn('Keyword highlighting failed', error);
          }
          renderAgain = true;
        },
      )
      .finally(() => {
        waiting = false;
        if (renderAgain) {
          renderAgain = false;
          schedule();
        }
      });
  };

  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    requestAnimationFrame(render);
  };

  const writeListener = terminal.onWriteParsed(schedule);
  const scrollListener = terminal.onScroll(schedule);
  const bufferListener = terminal.buffer.onBufferChange(schedule);
  schedule();

  return {
    setRules(nextRules) {
      rules = [...nextRules];
      rulesVersion++;
      schedule();
    },
    dispose() {
      disposed = true;
      writeListener.dispose();
      scrollListener.dispose();
      bufferListener.dispose();
      clear();
    },
  };
}
