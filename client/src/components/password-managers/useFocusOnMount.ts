import { useEffect, useRef } from 'react';

/**
 * A ref for the input a dialog should start typing in. Focus moves there one
 * frame after `when` turns true, once the dialog has mounted its content.
 */
export function useFocusOnMount(when = true) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!when) return undefined;
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [when]);
  return ref;
}
