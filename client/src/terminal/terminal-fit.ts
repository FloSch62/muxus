/**
 * A tab that is not in front sits under `display: none`, so its terminal
 * container has no layout box to measure. The fit addon reads a width of zero
 * there and falls back to its two-column floor, resizing the terminal — and
 * SIGWINCHing the remote shell — to two columns. The shell hard-wraps its
 * prompt at that width with real newlines, so the debris survives the refit
 * that happens when the tab comes back. Only measure a laid-out container.
 */
export function shouldFitTerminal(
  container: { clientWidth: number; clientHeight: number } | null | undefined,
): boolean {
  return !!container && container.clientWidth > 0 && container.clientHeight > 0;
}
