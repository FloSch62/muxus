import type { TerminalFileLinkActivation } from '../state/prefs.js';
import { terminalLinkActivationMatches } from './file-link-activation.js';

const WEB_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Give Electrobun the complete URL in the initial window-open request. The
 * desktop main process intercepts that request and opens it in the system
 * browser; WebLinksAddon's default two-step about:blank flow is denied before
 * it can assign the real URL.
 */
export function openTerminalWebLink(
  event: MouseEvent,
  uri: string,
  activation: TerminalFileLinkActivation | (() => TerminalFileLinkActivation) = 'direct',
  clearSelection?: () => void,
): void {
  const currentActivation = typeof activation === 'function' ? activation() : activation;
  if (!terminalLinkActivationMatches(event, currentActivation)) return;

  let url: string;
  try {
    const parsed = new URL(uri);
    if (!WEB_PROTOCOLS.has(parsed.protocol)) return;
    url = parsed.toString();
  } catch {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  clearSelection?.();
  window.open(url, '_blank', 'noopener');
}
