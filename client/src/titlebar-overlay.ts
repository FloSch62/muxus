import { titleBarColors } from './theme.js';

type TitleBarMode = 'light' | 'dark';

export type TitleBarDimmer = {
  /** Report the backdrop's current opacity (0..1). */
  set(opacity: number): void;
  release(): void;
};

let currentMode: TitleBarMode = 'light';
const backdropOpacities = new Map<object, number>();
let lastApplied: string | undefined;

// On Linux the native overlay background is transparent: the web AppBar and
// modal backdrop show through and dim in the same compositor frame as the
// rest of the page, so only the glyph color has to track the backdrop fade.
// Other platforms paint an opaque box, so both colors track the fade there.
const transparentBackground = window.muxusDesktop?.platform === 'linux';

function applyTitleBarOverlay() {
  const dim = backdropOpacities.size ? Math.max(...backdropOpacities.values()) : 0;
  const colors = titleBarColors(currentMode, { dim });
  if (transparentBackground) colors.color = '#00000000';
  const key = `${colors.color}|${colors.symbolColor}`;
  if (key === lastApplied) return;
  lastApplied = key;
  window.muxusDesktop?.setTitleBarOverlay(colors);
}

export function setTitleBarMode(mode: TitleBarMode) {
  currentMode = mode;
  applyTitleBarOverlay();
}

/** One dimmer per visible modal backdrop; the deepest dim wins when stacked. */
export function createTitleBarDimmer(): TitleBarDimmer {
  const key = {};
  return {
    set(opacity: number) {
      backdropOpacities.set(key, Math.min(1, Math.max(0, opacity)));
      applyTitleBarOverlay();
    },
    release() {
      backdropOpacities.delete(key);
      applyTitleBarOverlay();
    },
  };
}
