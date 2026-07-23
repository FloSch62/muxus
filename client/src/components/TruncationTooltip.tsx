import { cloneElement, useState, type MouseEvent, type ReactElement } from 'react';
import Tooltip from '@mui/material/Tooltip';

/**
 * Reveals an ellipsized label only when it is actually truncated. Measuring
 * when the pointer enters keeps the result correct after layout resizes.
 */
export function TruncationTooltip({
  text,
  measureSelector,
  children,
}: {
  text: string;
  /** Descendant that owns the ellipsis when the hover target is a wrapper. */
  measureSelector?: string;
  children: ReactElement<{ onMouseEnter?: (event: MouseEvent<HTMLElement>) => void }>;
}) {
  const [truncated, setTruncated] = useState(false);

  return (
    <Tooltip
      title={truncated ? text : ''}
      placement="bottom-start"
      enterDelay={300}
      enterNextDelay={150}
      disableInteractive
    >
      {cloneElement(children, {
        onMouseEnter: (event: MouseEvent<HTMLElement>) => {
          const root = event.currentTarget;
          const measured = (measureSelector ? root.querySelector(measureSelector) : root) ?? root;
          setTruncated(measured.scrollWidth > measured.clientWidth);
          children.props.onMouseEnter?.(event);
        },
      })}
    </Tooltip>
  );
}
