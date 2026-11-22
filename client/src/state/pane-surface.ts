import { create } from 'zustand';

/**
 * What a tab paints its pane with, when that is not the sheet color: a
 * terminal's scheme background. The pane's sheet takes it under the terminal,
 * so the two meet in one color at the sheet's rounded corners.
 */
interface PaneSurfaceState {
  colors: Readonly<Record<string, string>>;
  set: (tabId: string, color: string | undefined) => void;
}

export const usePaneSurfaceStore = create<PaneSurfaceState>((set) => ({
  colors: {},
  set: (tabId, color) =>
    set((state) => {
      if (state.colors[tabId] === color) return state;
      const colors = { ...state.colors };
      if (color === undefined) delete colors[tabId];
      else colors[tabId] = color;
      return { colors };
    }),
}));
