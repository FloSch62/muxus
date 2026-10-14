import { MAX_PACED_PASTE_LENGTH } from '@muxus/shared';
import { broadcastTerminalTyping } from '../state/multi-exec.js';
import { useTabsStore } from '../state/tabs.js';
import { showToast } from '../state/toast.js';
import { canSendBreak } from './send-break.js';
import { terminalHandle } from './terminal-registry.js';

/** A file goes to the serial, Telnet and SSH sessions that take BREAK, once attached. */
export const canSendTextFile = canSendBreak;

const tabById = (tabId: string) =>
  useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);

/**
 * A file's text, or why it cannot be typed. NUL bytes or invalid UTF-8 mean
 * binary; a UTF-8 BOM is dropped. Line breaks stay as they are: typing sends
 * CRLF, LF and CR each as one press of the host's Enter key.
 */
export function textFileContent(
  name: string,
  bytes: Uint8Array,
): { text: string } | { problem: string } {
  const binary = { problem: `“${name}” is not a text file, or not in UTF-8.` };
  if (bytes.includes(0)) return binary;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return binary;
  }
}

/**
 * Type a local text file into a tab and the sessions mirroring it, each at
 * its own host's paste pace, as a command button does.
 */
export async function sendTextFile(tabId: string, file: File): Promise<boolean> {
  // Refused here because typeText sends longer text unpaced. UTF-8 never takes
  // fewer bytes than UTF-16 code units, so the size bounds the text too.
  const content =
    file.size > MAX_PACED_PASTE_LENGTH
      ? { problem: `“${file.name}” is larger than ${MAX_PACED_PASTE_LENGTH / 1_000_000} MB. Send it in parts.` }
      : textFileContent(file.name, new Uint8Array(await file.arrayBuffer()));
  if ('problem' in content) {
    showToast('error', content.problem);
    return false;
  }
  if (!content.text) {
    showToast('info', `“${file.name}” is empty.`);
    return false;
  }
  const terminal = terminalHandle(tabId);
  if (!canSendTextFile(tabById(tabId)) || !terminal?.typeText(content.text)) {
    showToast('error', 'The session is no longer connected.');
    return false;
  }
  broadcastTerminalTyping(tabId, content.text);
  terminal.focus();
  return true;
}

/** Ask for a local text file to type into the tab; false when the tab takes none. */
export function requestSendTextFile(tabId: string | null | undefined): boolean {
  if (!tabId || !canSendTextFile(tabById(tabId))) return false;
  const input = document.createElement('input');
  input.type = 'file';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void sendTextFile(tabId, file);
  });
  input.click();
  return true;
}
