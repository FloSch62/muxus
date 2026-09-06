import { useLayoutEffect } from 'react';
import { clampInterfaceZoom } from '../interface-zoom.js';
import { usePrefsStore } from '../state/prefs.js';

/** Traffic lights retain their native size when the webview is zoomed. */
export function useNativeTitlebar(height: number): string {
  const scale = clampInterfaceZoom(usePrefsStore((state) => state.interfaceZoom));
  const mac = window.muxusDesktop?.platform === 'darwin';
  useLayoutEffect(() => {
    if (mac) window.muxusDesktop?.setTitlebarHeight(height * scale);
  }, [height, scale, mac]);
  return mac ? `${88 / scale}px` : '16px';
}
