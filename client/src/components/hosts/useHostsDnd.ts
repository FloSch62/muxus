import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from 'react';
import type { HostNode, HostTree, TreeNode, VisibleNode } from '../../host-tree.js';
import {
  canDropOnSection,
  planSectionDrop,
  sameSectionTarget,
  type HostSection,
  type SectionDropPlan,
  type SectionDropTarget,
} from '../../host-sections.js';
import { useHostDragStore } from '../../state/host-drag.js';
import { dragSourceForRow } from '../sidebar/tree-dnd.js';
import { setCountDragImage } from '../sidebar/useTreeDnd.js';

/** Where the insertion line is drawn, in the scrolled content's own coordinates. */
export interface DropIndicator {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How far from the top or bottom edge a drag starts scrolling the list. */
const SCROLL_EDGE = 56;
const SCROLL_STEP = 18;

export interface HostsDndOptions {
  /** The whole tree, unfiltered: it knows which folder every host is really in. */
  tree: HostTree;
  sections: readonly HostSection[];
  /** Cards flow in a grid and take a vertical line; table rows take a horizontal one. */
  layout: 'cards' | 'rows';
  /**
   * Whether what is on screen is the hosts' own order, so a drop can say
   * where a host should go. Hosts can be dragged away either way.
   */
  droppable: boolean;
  selection: ReadonlySet<string>;
  /** The scrolling element, and inside it the element sections are positioned in. */
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  onDrop: (plan: SectionDropPlan) => void;
}

/**
 * Drag and drop for the hosts tab. One set of listeners on the list resolves
 * the pointer to a section and a place among its hosts from the boxes on
 * screen, so the line that is drawn is exactly where the drop lands.
 *
 * The drag itself is shared with the sidebar tree: a host picked up here can
 * be dropped on a folder there, and one dragged from the tree lands here.
 */
export function useHostsDnd({
  tree,
  sections,
  layout,
  droppable,
  selection,
  scrollRef,
  contentRef,
  onDrop,
}: HostsDndOptions) {
  const source = useHostDragStore((state) => state.source);
  const setSource = useHostDragStore((state) => state.setSource);
  const [target, setTarget] = useState<SectionDropTarget | null>(null);
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const targetRef = useRef<SectionDropTarget | null>(null);

  const nodesByKey = useMemo(() => {
    const nodes = new Map<string, HostNode>();
    const walk = (children: readonly TreeNode[]) => {
      for (const child of children) {
        if (child.kind === 'host') nodes.set(child.key, child);
        else walk(child.children);
      }
    };
    walk(tree.roots);
    return nodes;
  }, [tree]);
  const nodesRef = useRef(nodesByKey);
  nodesRef.current = nodesByKey;
  const sectionsByKey = useMemo(
    () => new Map(sections.map((section) => [section.key, section])),
    [sections],
  );

  const clearTarget = useCallback(() => {
    targetRef.current = null;
    setTarget(null);
    setIndicator(null);
  }, []);

  // The drag may end over the sidebar, or be cancelled with Escape.
  useEffect(() => {
    if (!source) clearTarget();
  }, [source, clearTarget]);

  const onDragStart = useCallback(
    (event: DragEvent<HTMLElement>, hostKey: string) => {
      const node = nodesRef.current.get(hostKey);
      // Only the node and its key are read to decide what a drag picks up.
      const next = node
        ? dragSourceForRow({ node, key: hostKey } as VisibleNode, treeRef.current, selectionRef.current)
        : undefined;
      if (!next) {
        event.preventDefault();
        return;
      }
      // Moved within the lists; copied onto a pane, which opens a session there.
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData('text/plain', hostKey);
      if (next.kind === 'host' && next.hosts.length > 1) {
        setCountDragImage(event, `${next.hosts.length} hosts`);
      }
      setSource(next);
    },
    [setSource],
  );

  const onDragEnd = useCallback(() => {
    setSource(null);
    clearTarget();
  }, [setSource, clearTarget]);

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!source || source.kind !== 'host' || !droppable) return;
      const scroller = scrollRef.current;
      const content = contentRef.current;
      if (!scroller || !content) return;

      // Native drags do not scroll the list they are over on every platform.
      const bounds = scroller.getBoundingClientRect();
      if (event.clientY < bounds.top + SCROLL_EDGE) scroller.scrollTop -= SCROLL_STEP;
      else if (event.clientY > bounds.bottom - SCROLL_EDGE) scroller.scrollTop += SCROLL_STEP;

      const hit = hitTest(content, event.clientX, event.clientY, layout);
      const section = hit ? sectionsByKey.get(hit.target.sectionKey) : undefined;
      if (!hit || !section || !canDropOnSection(source, section)) {
        if (targetRef.current) clearTarget();
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (sameSectionTarget(targetRef.current, hit.target)) return;
      targetRef.current = hit.target;
      setTarget(hit.target);
      // Where the hosts already are there is nothing to announce.
      setIndicator(planSectionDrop(source, section, hit.target) ? hit.indicator : null);
    },
    [source, droppable, scrollRef, contentRef, layout, sectionsByKey, clearTarget],
  );

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const related = event.relatedTarget;
      if (related instanceof Node && event.currentTarget.contains(related)) return;
      clearTarget();
    },
    [clearTarget],
  );

  const onDropEvent = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const current = targetRef.current;
      const section = current ? sectionsByKey.get(current.sectionKey) : undefined;
      if (!source || !current || !section) return;
      event.preventDefault();
      const plan = planSectionDrop(source, section, current);
      setSource(null);
      clearTarget();
      if (plan) onDrop(plan);
    },
    [source, sectionsByKey, setSource, clearTarget, onDrop],
  );

  const draggedKeys = useMemo(
    () => new Set(source?.kind === 'host' ? source.hosts.map((host) => host.hostKey) : []),
    [source],
  );

  return {
    /** Something that could be dropped here is in the air, from here or from the sidebar. */
    dragging: source?.kind === 'host',
    draggedKeys,
    target,
    indicator,
    onDragStart,
    onDragEnd,
    containerProps: { onDragOver, onDragLeave, onDrop: onDropEvent },
  };
}

interface Hit {
  target: SectionDropTarget;
  indicator: DropIndicator | null;
}

/**
 * The section under the pointer and the place among its hosts the pointer is
 * closest to. Measured from the boxes on screen rather than `event.target`,
 * which keeps naming the element a drag last settled on.
 */
function hitTest(content: HTMLElement, x: number, y: number, layout: 'cards' | 'rows'): Hit | undefined {
  let sectionElement: HTMLElement | undefined;
  for (const element of content.querySelectorAll<HTMLElement>('[data-section-key]')) {
    const rect = element.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) {
      sectionElement = element;
      break;
    }
  }
  const sectionKey = sectionElement?.dataset.sectionKey;
  if (!sectionElement || !sectionKey) return undefined;

  const origin = content.getBoundingClientRect();
  const items = [...sectionElement.querySelectorAll<HTMLElement>('[data-host-key]')].map((element) => ({
    key: element.dataset.hostKey!,
    rect: element.getBoundingClientRect(),
  }));
  if (items.length === 0) return { target: { sectionKey }, indicator: null };

  if (layout === 'rows') {
    const next = items.find((item) => y < item.rect.top + item.rect.height / 2);
    const edge = next ? next.rect.top : items[items.length - 1]!.rect.bottom;
    const first = items[0]!.rect;
    return {
      target: { sectionKey, beforeKey: next?.key },
      indicator: { left: first.left - origin.left, top: edge - origin.top - 1, width: first.width, height: 2 },
    };
  }

  // Cards wrap: find the row of cards the pointer is level with, then the gap
  // in that row it is nearest to.
  const rows: (typeof items)[] = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.rect.top - item.rect.top) < 2) row.push(item);
    else rows.push([item]);
  }
  const level = rows.findIndex((candidate) => y <= candidate[0]!.rect.bottom + 4);
  const row = rows[level === -1 ? rows.length - 1 : level]!;
  const index = row.findIndex((item) => x < item.rect.left + item.rect.width / 2);
  const gap = row.length > 1 ? row[1]!.rect.left - row[0]!.rect.right : 8;
  if (index >= 0) {
    const item = row[index]!;
    return {
      target: { sectionKey, beforeKey: item.key },
      indicator: {
        left: item.rect.left - origin.left - gap / 2 - 1,
        top: item.rect.top - origin.top,
        width: 2,
        height: item.rect.height,
      },
    };
  }
  // Past the last card of a row: before the first card of the next one.
  const last = row[row.length - 1]!;
  return {
    target: { sectionKey, beforeKey: rows[rows.indexOf(row) + 1]?.[0]?.key },
    indicator: {
      left: last.rect.right - origin.left + gap / 2 - 1,
      top: last.rect.top - origin.top,
      width: 2,
      height: last.rect.height,
    },
  };
}
