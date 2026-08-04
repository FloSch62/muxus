const EDITOR_LINE_HEIGHT_PX = 18;
const MAX_RENDERED_LINE_NUMBERS = 20;

export interface PasteLineNumberWindow {
  labels: string;
  offsetPx: number;
}

/** Return only the line-number labels visible in the fixed-height paste editor. */
export function pasteLineNumberWindow(
  lineCount: number,
  scrollTop: number,
  lineHeightPx = EDITOR_LINE_HEIGHT_PX,
): PasteLineNumberWindow {
  const boundedLineCount = Math.max(1, Math.floor(lineCount));
  const boundedScrollTop = Math.max(0, scrollTop);
  const boundedLineHeight =
    Number.isFinite(lineHeightPx) && lineHeightPx > 0 ? lineHeightPx : EDITOR_LINE_HEIGHT_PX;
  const firstIndex = Math.min(
    Math.floor(boundedScrollTop / boundedLineHeight),
    boundedLineCount - 1,
  );
  const endIndex = Math.min(boundedLineCount, firstIndex + MAX_RENDERED_LINE_NUMBERS);

  let labels = '';
  for (let index = firstIndex; index < endIndex; index += 1) {
    if (labels) labels += '\n';
    labels += String(index + 1);
  }

  return {
    labels,
    offsetPx: boundedScrollTop - firstIndex * boundedLineHeight,
  };
}
