import type { ITheme } from '@xterm/xterm';

/**
 * Terminal colors. The background is a fixed near-black regardless of app
 * theme (light-mode terminals are a lie), tuned to sit next to the Muxus
 * dark chrome; the ANSI ramp is periwinkle-forward to match the app accent.
 */
export const TERMINAL_BACKGROUND = '#16161e';

export const terminalTheme: ITheme = {
  background: TERMINAL_BACKGROUND,
  foreground: '#c8ccd8',
  cursor: '#c8ccd8',
  cursorAccent: TERMINAL_BACKGROUND,
  selectionBackground: 'rgba(110, 139, 251, 0.32)',
  black: '#1a1b26',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#ff899d',
  brightGreen: '#b9f27c',
  brightYellow: '#ffbf7a',
  brightBlue: '#8db0ff',
  brightMagenta: '#c7a9ff',
  brightCyan: '#a4daff',
  brightWhite: '#c0caf5',
};
