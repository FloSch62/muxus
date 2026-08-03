export const TAB_TRANSFER_MIME = 'application/x-muxus-tab';
const TEXT_PREFIX = 'muxus-tab:';

let active: { tabId: string; transferId: string } | undefined;

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Start the synchronous portion of an HTML drag; cross-window setup stays lazy. */
export function beginTabDrag(tabId: string): string {
  const transferId = randomId();
  active = { tabId, transferId };
  return transferId;
}

export function activeTabTransfer(): { tabId: string; transferId: string } | undefined {
  return active;
}

export function endTabDrag(transferId: string): void {
  if (active?.transferId === transferId) active = undefined;
}

export function writeTabTransfer(dataTransfer: DataTransfer, transferId: string): void {
  dataTransfer.setData(TAB_TRANSFER_MIME, transferId);
  dataTransfer.setData('text/plain', `${TEXT_PREFIX}${transferId}`);
}

export function hasTabTransfer(dataTransfer: DataTransfer): boolean {
  // Custom types are listed during dragover in every supported browser, so a
  // text/plain fallback here would only make ordinary text drags look droppable.
  return Array.from(dataTransfer.types).includes(TAB_TRANSFER_MIME);
}

export function readTabTransfer(dataTransfer: DataTransfer): string | undefined {
  const custom = dataTransfer.getData(TAB_TRANSFER_MIME);
  if (custom) return custom;
  const text = dataTransfer.getData('text/plain');
  return text.startsWith(TEXT_PREFIX) ? text.slice(TEXT_PREFIX.length) : undefined;
}
