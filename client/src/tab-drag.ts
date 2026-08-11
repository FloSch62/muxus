export const TAB_TRANSFER_MIME = 'application/x-muxus-tab';

let active: { tabId: string; transferId: string } | undefined;

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Create the opaque identity shared by a source and destination renderer. */
export function createTabTransferId(): string {
  return randomId();
}

/** Start the synchronous portion of an HTML drag; cross-window setup stays lazy. */
export function beginTabDrag(tabId: string): string {
  const transferId = createTabTransferId();
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
  // A text/plain payload is exported by the OS as a "Dragged Text" file when
  // the pointer leaves the window. Keep tab drags private to Muxus instead.
  dataTransfer.clearData();
  dataTransfer.setData(TAB_TRANSFER_MIME, transferId);
}

export function hasTabTransfer(dataTransfer: DataTransfer): boolean {
  // Custom types are listed during dragover in every supported browser, so a
  // text/plain fallback here would only make ordinary text drags look droppable.
  return Array.from(dataTransfer.types).includes(TAB_TRANSFER_MIME);
}

export function readTabTransfer(dataTransfer: DataTransfer): string | undefined {
  const custom = dataTransfer.getData(TAB_TRANSFER_MIME);
  return custom || undefined;
}

interface WindowScreenBounds {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
}

/** A rejected drop is a detach only when the pointer actually left this window. */
export function shouldDetachTabDrag(
  event: Pick<DragEvent, 'dataTransfer' | 'screenX' | 'screenY'>,
  bounds: WindowScreenBounds = window,
): boolean {
  if (event.dataTransfer?.dropEffect !== 'none') return false;
  const right = bounds.screenX + bounds.outerWidth;
  const bottom = bounds.screenY + bounds.outerHeight;
  return (
    event.screenX < bounds.screenX ||
    event.screenX >= right ||
    event.screenY < bounds.screenY ||
    event.screenY >= bottom
  );
}
