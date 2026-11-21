import { create } from 'zustand';
import type { DragSource } from '../components/sidebar/tree-dnd.js';

/**
 * What is being dragged, for every place that lists hosts. The sidebar tree
 * and the hosts tab each start drags and each take drops, so the source lives
 * here rather than in either of them: a card picked up in the tab can then be
 * dropped on a folder in the sidebar, and the other way round. (A drag's own
 * payload cannot carry it — the browser hides it until the drop.)
 */
interface HostDragState {
  source: DragSource | null;
  setSource: (source: DragSource | null) => void;
}

export const useHostDragStore = create<HostDragState>()((set) => ({
  source: null,
  setSource: (source) => set({ source }),
}));
