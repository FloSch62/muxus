import type { ElementType } from 'react';
import { alpha, createTheme, type Theme } from '@mui/material/styles';
import { DEFAULT_SIDEBAR_WIDTH } from './sidebar-width.js';
import { DEFAULT_SFTP_PANEL_WIDTH } from './sftp-panel-width.js';

declare module '@mui/material/styles' {
  /** Chrome surfaces (top bar, session sidebar, tab strip) share this background —
   *  exposed on the palette so no component re-hardcodes the hex. `sidebarInk`
   *  is the label color for sidebar rows: in light mode it sits below
   *  text.primary because a panel of near-black rows reads as a slab of ink. */
  interface Palette {
    sidebar: string;
    sidebarInk: string;
  }
  interface PaletteOptions {
    sidebar?: string;
    sidebarInk?: string;
  }
}

/**
 * Shared layout dimensions. Several of these are cross-file contracts:
 * anything that changes one side must keep the other in sync, so both sides
 * read the same token instead of repeating the number.
 */
export const layout = {
  /** TopBar toolbar height; the Electron titlebar overlay uses the same value. */
  topBarHeight: 52,
  /** Minimal draggable titlebar retained while focus mode hides application chrome. */
  focusTopBarHeight: 32,
  /** Session sidebar width. */
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  /** Tab strip height under the top bar. */
  tabStripHeight: 40,
  /** Default SFTP panel width. */
  sftpPanelWidth: DEFAULT_SFTP_PANEL_WIDTH,
  /** Forwarding side panel width. */
  forwardingPanelWidth: 380,
  /** Themed scrollbar thickness. */
  scrollbarSize: 10,
} as const;

const modalBackdropAlpha = 0.5;

/** Status hue for small colored text. The bright palette mains pass contrast
 *  on dark paper but fail WCAG AA as 12-13px text on the light backgrounds,
 *  so light mode drops to the pinned `dark` variant. */
export const statusTextColor =
  (color: 'success' | 'error' | 'warning' | 'info') =>
  (theme: Theme): string =>
    theme.palette.mode === 'dark' ? theme.palette[color].main : theme.palette[color].dark;

const darkColors = {
  primary: '#6e8bfb',
  secondary: '#2dd4bf',
  bgDefault: '#1b1b1f',
  bgPaper: '#232328',
  sidebar: '#151518',
  sidebarInk: '#e6e6ea',
  divider: 'rgba(255, 255, 255, 0.08)',
  textPrimary: '#e6e6ea',
  textSecondary: '#9d9da7',
  success: '#4ade80',
  warning: '#e7b341',
  error: '#f87171',
  info: '#60a5fa',
  scrollThumb: 'rgba(255, 255, 255, 0.16)',
  scrollThumbHover: 'rgba(255, 255, 255, 0.30)',
  tooltipBg: '#2e2e34',
  selectedPill: 'rgba(255, 255, 255, 0.09)',
  selectedPillHover: 'rgba(255, 255, 255, 0.13)',
};

const lightColors = {
  primary: '#3b66f5',
  secondary: '#0d9488',
  bgDefault: '#fafafa',
  bgPaper: '#ffffff',
  sidebar: '#f4f4f5',
  sidebarInk: '#3f3f49',
  divider: 'rgba(0, 0, 0, 0.08)',
  textPrimary: '#1c1c21',
  textSecondary: '#6e6e78',
  success: '#16a34a',
  warning: '#b07a10',
  error: '#dc2626',
  info: '#2563eb',
  scrollThumb: 'rgba(0, 0, 0, 0.18)',
  scrollThumbHover: 'rgba(0, 0, 0, 0.34)',
  tooltipBg: '#2e2e34',
  selectedPill: 'rgba(0, 0, 0, 0.07)',
  selectedPillHover: 'rgba(0, 0, 0, 0.10)',
};

/** Colors the desktop app paints the native window-controls overlay with —
 *  must match the rendered TopBar (AppBar uses `sidebar` as background). */
export function titleBarColors(mode: 'light' | 'dark', options: { dim?: number } = {}): { color: string; symbolColor: string } {
  const c = mode === 'dark' ? darkColors : lightColors;
  const dim = options.dim ?? 0;
  return {
    color: compositeModalBackdrop(c.sidebar, dim),
    symbolColor: compositeModalBackdrop(c.textPrimary, dim),
  };
}

/** Composite the modal backdrop (black at modalBackdropAlpha × backdropOpacity)
 *  over an opaque hex color, so the native overlay can match the web backdrop
 *  at any point during its fade. */
function compositeModalBackdrop(hex: string, backdropOpacity: number): string {
  if (backdropOpacity <= 0) return hex;
  const factor = 1 - modalBackdropAlpha * Math.min(1, backdropOpacity);
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return `#${channels.map((channel) => Math.round(channel * factor).toString(16).padStart(2, '0')).join('')}`;
}

export function buildTheme(mode: 'light' | 'dark', options: { modalBackdrop?: ElementType } = {}): Theme {
  const dark = mode === 'dark';
  const c = dark ? darkColors : lightColors;

  return createTheme({
    palette: {
      mode,
      primary: { main: c.primary },
      secondary: { main: c.secondary },
      // Light mode pins the `dark` variants to hues that pass WCAG AA as
      // small text on the near-white backgrounds (see statusTextColor).
      success: { main: c.success, ...(dark ? {} : { dark: '#15803d' }) },
      warning: { main: c.warning, ...(dark ? {} : { dark: '#8f6209' }) },
      error: { main: c.error, ...(dark ? {} : { dark: '#b91c1c' }) },
      info: { main: c.info, ...(dark ? {} : { dark: '#1d4ed8' }) },
      divider: c.divider,
      sidebar: c.sidebar,
      sidebarInk: c.sidebarInk,
      background: { default: c.bgDefault, paper: c.bgPaper },
      // `disabled` is used as the dimmest text tier; keying it off the
      // secondary hue keeps the two muted greys in the same family instead
      // of MUI's unrelated default.
      text: { primary: c.textPrimary, secondary: c.textSecondary, disabled: alpha(c.textSecondary, dark ? 0.55 : 0.6) },
    },
    shape: { borderRadius: 8 },
    typography: {
      // Bundled variable font (see main.tsx) — variable weights make the
      // 550 emphasis tier real instead of snapping to 600.
      fontFamily: '"Inter Variable", "Inter", -apple-system, "Segoe UI", "Roboto", "Helvetica", "Arial", sans-serif',
      fontSize: 13,
      h5: { fontWeight: 600, letterSpacing: -0.2 },
      h6: { fontWeight: 600, letterSpacing: -0.2 },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      button: { fontWeight: 550 },
    },
    components: {
      ...(options.modalBackdrop
        ? {
            MuiDrawer: {
              defaultProps: {
                slots: { backdrop: options.modalBackdrop },
              },
            },
            MuiModal: {
              defaultProps: {
                slots: { backdrop: options.modalBackdrop },
              },
            },
          }
        : {}),
      MuiCssBaseline: {
        styleOverrides: {
          '*': {
            scrollbarWidth: 'thin',
            scrollbarColor: `${c.scrollThumb} transparent`,
          },
          '*::-webkit-scrollbar': { width: layout.scrollbarSize, height: layout.scrollbarSize },
          '*::-webkit-scrollbar-track': { background: 'transparent' },
          '*::-webkit-scrollbar-thumb': {
            backgroundColor: c.scrollThumb,
            borderRadius: 8,
            border: '2px solid transparent',
            backgroundClip: 'content-box',
            '&:hover': { backgroundColor: c.scrollThumbHover },
          },
          '*::-webkit-scrollbar-corner': { background: 'transparent' },
          '::selection': { backgroundColor: alpha(c.primary, 0.3) },
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundColor: c.sidebar } },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: 'none' } },
      },
      MuiButton: {
        defaultProps: { size: 'small' },
        styleOverrides: { root: { textTransform: 'none', borderRadius: 7 } },
      },
      MuiToggleButton: {
        styleOverrides: { root: { textTransform: 'none', fontWeight: 550 } },
      },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: c.divider },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: alpha(c.primary, 0.5) },
          },
        },
      },
      MuiChip: {
        defaultProps: { size: 'small' },
        styleOverrides: { root: { fontWeight: 500 } },
      },
      MuiTooltip: {
        defaultProps: { arrow: true },
        styleOverrides: {
          tooltip: { backgroundColor: c.tooltipBg, fontSize: 12, padding: '6px 10px', borderRadius: 6 },
          arrow: { color: c.tooltipBg },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: { borderRadius: 10, borderColor: c.divider },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            borderRadius: 10,
            border: `1px solid ${c.divider}`,
            boxShadow: dark ? '0 8px 28px rgba(0, 0, 0, 0.5)' : '0 8px 28px rgba(0, 0, 0, 0.12)',
          },
        },
      },
      MuiAutocomplete: {
        styleOverrides: {
          paper: {
            borderRadius: 10,
            border: `1px solid ${c.divider}`,
            boxShadow: dark ? '0 8px 28px rgba(0, 0, 0, 0.5)' : '0 8px 28px rgba(0, 0, 0, 0.12)',
          },
        },
      },
      MuiDialog: {
        defaultProps: options.modalBackdrop ? { slots: { backdrop: options.modalBackdrop } } : undefined,
        styleOverrides: {
          paper: {
            borderRadius: 12,
            border: `1px solid ${c.divider}`,
          },
        },
      },
      MuiDialogContent: {
        styleOverrides: {
          root: {
            // The content is a scroll box, so it clips whatever pokes out of
            // it — including the floating label of a field at the very top,
            // which sits ~9px above its input. MUI drops the top padding when
            // the content follows a title; take it back as padding and hand it
            // straight back as margin, so the labels survive and nothing moves.
            '.MuiDialogTitle-root + &:not(.MuiDialogContent-dividers)': {
              paddingTop: 12,
              marginTop: -12,
            },
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 550,
            minHeight: 40,
            color: c.textSecondary,
            '&.Mui-selected': { color: c.textPrimary },
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 40 },
          indicator: { height: 2, borderRadius: '2px 2px 0 0', backgroundColor: c.textPrimary },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            margin: '1px 6px',
            '&:hover': { backgroundColor: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' },
            '&.Mui-selected': {
              backgroundColor: c.selectedPill,
              '&:hover': { backgroundColor: c.selectedPillHover },
              '& .MuiListItemText-primary': { fontWeight: 600, color: c.textPrimary },
              '& .MuiListItemIcon-root': { color: c.textPrimary },
            },
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { borderBottomColor: c.divider },
          head: {
            fontWeight: 550,
            fontSize: 12,
            color: c.textSecondary,
          },
        },
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: { borderRadius: 3, backgroundColor: alpha(c.textSecondary, 0.15) },
        },
      },
      MuiAlert: {
        styleOverrides: { root: { borderRadius: 8 } },
      },
    },
  });
}
