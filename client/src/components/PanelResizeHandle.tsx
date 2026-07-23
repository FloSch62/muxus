import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import Box from '@mui/material/Box';

interface ResizeState {
  pointerId: number;
  startX: number;
  startWidth: number;
  containerWidth: number;
  pendingWidth: number;
  frame: number;
  bodyCursor: string;
  bodyUserSelect: string;
}

/**
 * Shared, accessible side-panel resizer. Pointer movement writes straight to
 * the panel once per animation frame; React state is committed only on release.
 */
export function PanelResizeHandle({
  panelRef,
  edge,
  width,
  defaultWidth,
  minWidth,
  maxWidth,
  clampWidth,
  onWidthChange,
  label,
}: {
  panelRef: RefObject<HTMLElement | null>;
  edge: 'left' | 'right';
  width: number;
  defaultWidth: number;
  minWidth: number;
  maxWidth: (containerWidth: number) => number;
  clampWidth: (width: number, containerWidth: number) => number;
  onWidthChange: (width: number) => void;
  label: string;
}) {
  const resizeRef = useRef<ResizeState | undefined>(undefined);

  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.style.width = '';
  }, [panelRef, width]);

  useEffect(
    () => () => {
      const resize = resizeRef.current;
      if (!resize) return;
      if (resize.frame) cancelAnimationFrame(resize.frame);
      document.body.style.cursor = resize.bodyCursor;
      document.body.style.userSelect = resize.bodyUserSelect;
    },
    [],
  );

  const resizeWithKeyboard = (nextWidth: number) => {
    const containerWidth = panelRef.current?.parentElement?.clientWidth ?? window.innerWidth;
    onWidthChange(clampWidth(nextWidth, containerWidth));
  };

  const startResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const panel = panelRef.current;
    const container = panel?.parentElement;
    if (!panel || !container) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = panel.getBoundingClientRect().width;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      containerWidth: container.clientWidth,
      pendingWidth: startWidth,
      frame: 0,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
    };
    panel.style.transition = 'none';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const moveResize = (event: ReactPointerEvent<HTMLElement>) => {
    const resize = resizeRef.current;
    const panel = panelRef.current;
    if (!resize || resize.pointerId !== event.pointerId || !panel) return;
    const pointerDelta = event.clientX - resize.startX;
    resize.pendingWidth = clampWidth(
      resize.startWidth + pointerDelta * (edge === 'right' ? 1 : -1),
      resize.containerWidth,
    );
    if (resize.frame) return;
    resize.frame = requestAnimationFrame(() => {
      resize.frame = 0;
      panel.style.width = `${resize.pendingWidth}px`;
    });
  };

  const finishResize = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const resize = resizeRef.current;
    const panel = panelRef.current;
    if (!resize || resize.pointerId !== event.pointerId || !panel) return;
    if (resize.frame) cancelAnimationFrame(resize.frame);
    const nextWidth = commit ? resize.pendingWidth : resize.startWidth;
    panel.style.width = `${nextWidth}px`;
    panel.style.transition = '';
    document.body.style.cursor = resize.bodyCursor;
    document.body.style.userSelect = resize.bodyUserSelect;
    resizeRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit) onWidthChange(nextWidth);
  };

  const announcedMaxWidth = maxWidth(window.innerWidth);
  const announcedWidth = clampWidth(width, window.innerWidth);
  const keyboardDirection = edge === 'right' ? 1 : -1;

  return (
    <Box
      component="hr"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={announcedMaxWidth}
      aria-valuenow={announcedWidth}
      aria-valuetext={`${announcedWidth} pixels`}
      tabIndex={0}
      onDoubleClick={() => resizeWithKeyboard(defaultWidth)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
        event.preventDefault();
        const pointerDelta = event.key === 'ArrowRight' ? 20 : -20;
        resizeWithKeyboard(
          event.key === 'Home' ? defaultWidth : width + pointerDelta * keyboardDirection,
        );
      }}
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={(event) => finishResize(event, true)}
      onPointerCancel={(event) => finishResize(event, false)}
      onLostPointerCapture={(event) => finishResize(event, false)}
      sx={{
        position: 'absolute',
        [edge]: -4,
        top: 0,
        bottom: 0,
        width: 8,
        zIndex: 5,
        cursor: 'col-resize',
        touchAction: 'none',
        outline: 'none',
        border: 0,
        m: 0,
        p: 0,
        '&::after': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: '50%',
          width: 3,
          transform: 'translateX(-50%)',
          bgcolor: 'primary.main',
          opacity: 0,
          transition: 'opacity 120ms ease',
        },
        '&:hover::after, &:active::after, &:focus-visible::after': { opacity: 1 },
      }}
    />
  );
}
