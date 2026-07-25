import type { ITheme } from '@xterm/xterm';

/** WCAG AA contrast floor enforced by xterm for every rendered text cell. */
export const TERMINAL_MINIMUM_CONTRAST_RATIO = 4.5;

/**
 * Built-in terminal color schemes. The default matches VS Code's stock dark
 * terminal so the out-of-the-box look is what most people already stare at
 * all day; the rest are faithful renditions of the classics people expect
 * from a terminal, plus a few light palettes tuned to stay readable for a
 * full workday.
 */
export interface TerminalScheme {
  id: string;
  name: string;
  /** Reads as a light background (selection/contrast handling differs). */
  light?: boolean;
  theme: ITheme;
}

/** VS Code Dark Modern chrome with the default ANSI palette from its
 *  terminal color registry. */
const vscodeDark: ITheme = {
  background: '#181818',
  foreground: '#cccccc',
  cursor: '#cccccc',
  cursorAccent: '#181818',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
};

/** Fixed near-black tuned to sit next to the Muxus dark chrome, with a
 *  periwinkle-forward ANSI ramp to match the app accent. */
const muxus: ITheme = {
  background: '#16161e',
  foreground: '#c8ccd8',
  cursor: '#c8ccd8',
  cursorAccent: '#16161e',
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

const dracula: ITheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: 'rgba(68, 71, 90, 0.7)',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
};

const oneDark: ITheme = {
  background: '#282c34',
  foreground: '#abb2bf',
  cursor: '#528bff',
  cursorAccent: '#282c34',
  selectionBackground: 'rgba(62, 68, 81, 0.8)',
  black: '#282c34',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
};

const nord: ITheme = {
  background: '#2e3440',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  cursorAccent: '#2e3440',
  selectionBackground: 'rgba(76, 86, 106, 0.6)',
  black: '#3b4252',
  red: '#bf616a',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  white: '#e5e9f0',
  brightBlack: '#4c566a',
  brightRed: '#bf616a',
  brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb',
  brightWhite: '#eceff4',
};

const gruvboxDark: ITheme = {
  background: '#282828',
  foreground: '#ebdbb2',
  cursor: '#ebdbb2',
  cursorAccent: '#282828',
  selectionBackground: 'rgba(80, 73, 69, 0.7)',
  black: '#282828',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#ebdbb2',
};

const catppuccinMocha: ITheme = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: 'rgba(88, 91, 112, 0.6)',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

const monokai: ITheme = {
  background: '#272822',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#272822',
  selectionBackground: 'rgba(73, 72, 62, 0.8)',
  black: '#272822',
  red: '#f92672',
  green: '#a6e22e',
  yellow: '#e6db74',
  blue: '#66d9ef',
  magenta: '#ae81ff',
  cyan: '#a1efe4',
  white: '#f8f8f2',
  brightBlack: '#75715e',
  brightRed: '#f92672',
  brightGreen: '#a6e22e',
  brightYellow: '#e6db74',
  brightBlue: '#66d9ef',
  brightMagenta: '#ae81ff',
  brightCyan: '#a1efe4',
  brightWhite: '#f9f8f5',
};

const solarizedDark: ITheme = {
  background: '#002b36',
  foreground: '#839496',
  cursor: '#839496',
  cursorAccent: '#002b36',
  selectionBackground: 'rgba(7, 54, 66, 0.9)',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
};

const solarizedLight: ITheme = {
  background: '#fdf6e3',
  foreground: '#657b83',
  cursor: '#657b83',
  cursorAccent: '#fdf6e3',
  selectionBackground: 'rgba(238, 232, 213, 1)',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#93a1a1',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
};

/** Warm, low-glare paper with deliberately restrained ANSI colors. */
const paper: ITheme = {
  background: '#f5f0e6',
  foreground: '#403b33',
  cursor: '#765b3d',
  cursorAccent: '#f5f0e6',
  selectionBackground: 'rgba(183, 157, 111, 0.38)',
  black: '#282622',
  red: '#a63d40',
  green: '#52783d',
  yellow: '#866316',
  blue: '#386b8c',
  magenta: '#795080',
  cyan: '#39766f',
  white: '#d8d1c3',
  brightBlack: '#706a60',
  brightRed: '#bd4f4b',
  brightGreen: '#648947',
  brightYellow: '#9d741b',
  brightBlue: '#4b7b9a',
  brightMagenta: '#8d6092',
  brightCyan: '#4a8780',
  brightWhite: '#fffaf0',
};

/** VS Code's light terminal palette, with its pale-blue selection. */
const vscodeLight: ITheme = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#333333',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#008000',
  yellow: '#795e26',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#767676',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#16825d',
  brightYellow: '#8f6d20',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  // Keep ANSI bright white genuinely light: tools such as GNU ls use bold
  // white over a red background to call out broken symlinks.
  brightWhite: '#ffffff',
};

const githubLight: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(9, 105, 218, 0.24)',
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#d0d7de',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#116329',
  brightYellow: '#7d4e00',
  brightBlue: '#0550ae',
  brightMagenta: '#6639ba',
  brightCyan: '#0a676d',
  brightWhite: '#ffffff',
};

const gruvboxLight: ITheme = {
  background: '#fbf1c7',
  foreground: '#3c3836',
  cursor: '#3c3836',
  cursorAccent: '#fbf1c7',
  selectionBackground: '#d5c4a1',
  black: '#282828',
  red: '#9d0006',
  green: '#79740e',
  yellow: '#b57614',
  blue: '#076678',
  magenta: '#8f3f71',
  cyan: '#427b58',
  white: '#d5c4a1',
  brightBlack: '#7c6f64',
  brightRed: '#cc241d',
  brightGreen: '#98971a',
  brightYellow: '#d79921',
  brightBlue: '#458588',
  brightMagenta: '#b16286',
  brightCyan: '#689d6a',
  brightWhite: '#fbf1c7',
};

const catppuccinLatte: ITheme = {
  background: '#eff1f5',
  foreground: '#4c4f69',
  cursor: '#dc8a78',
  cursorAccent: '#eff1f5',
  selectionBackground: 'rgba(172, 176, 190, 0.55)',
  black: '#5c5f77',
  red: '#d20f39',
  green: '#40a02b',
  yellow: '#b36b00',
  blue: '#1e66f5',
  magenta: '#8839ef',
  cyan: '#0f7f85',
  white: '#acb0be',
  brightBlack: '#6c6f85',
  brightRed: '#b80b31',
  brightGreen: '#348822',
  brightYellow: '#965800',
  brightBlue: '#1856ce',
  brightMagenta: '#762fd3',
  brightCyan: '#0b6b70',
  brightWhite: '#eff1f5',
};

export const TERMINAL_SCHEMES: readonly TerminalScheme[] = [
  { id: 'paper', name: 'Paper', light: true, theme: paper },
  { id: 'vscode-light', name: 'Light (VS Code)', light: true, theme: vscodeLight },
  { id: 'github-light', name: 'GitHub Light', light: true, theme: githubLight },
  { id: 'gruvbox-light', name: 'Gruvbox Light', light: true, theme: gruvboxLight },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', light: true, theme: catppuccinLatte },
  { id: 'solarized-light', name: 'Solarized Light', light: true, theme: solarizedLight },
  { id: 'vscode-dark', name: 'Dark (VS Code)', theme: vscodeDark },
  { id: 'muxus', name: 'Muxus', theme: muxus },
  { id: 'dracula', name: 'Dracula', theme: dracula },
  { id: 'one-dark', name: 'One Dark', theme: oneDark },
  { id: 'nord', name: 'Nord', theme: nord },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', theme: gruvboxDark },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', theme: catppuccinMocha },
  { id: 'monokai', name: 'Monokai', theme: monokai },
  { id: 'solarized-dark', name: 'Solarized Dark', theme: solarizedDark },
].map((scheme) => ({
  ...scheme,
  // xterm outlines the overview ruler with overviewRulerBorder, which
  // defaults to the foreground color — a bright line down the right edge.
  // Marks should float over the terminal with no visible ruler chrome.
  theme: { ...scheme.theme, overviewRulerBorder: '#00000000' },
}));

const SCHEMES_BY_ID = new Map(TERMINAL_SCHEMES.map((scheme) => [scheme.id, scheme]));
const DEFAULT_SCHEME = SCHEMES_BY_ID.get('vscode-dark')!;

/** Resolve a scheme id, falling back to the VS Code dark default. */
export function terminalScheme(id: string | undefined): TerminalScheme {
  return (id === undefined ? undefined : SCHEMES_BY_ID.get(id)) ?? DEFAULT_SCHEME;
}
