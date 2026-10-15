import { sessionLogName, type SessionLogSummary, type SftpFileResponse } from '@muxus/shared';
import { apiFetch, apiFetchRaw } from './api/http.js';
import { showErrorToast } from './state/toast.js';
import { useUiStore } from './state/ui.js';

/** One side of the compare dialog. */
export interface CompareText {
  label: string;
  text: string;
  /** A file read over SFTP, so a second file on that connection starts from its path. */
  remote?: { connId: string; host: string; path: string };
}

/** Texts above this many characters are refused, as files above 8 MiB are. */
export const MAX_COMPARE_CHARS = 8 * 1024 * 1024;

/** Throws when the text is too large to compare. */
export function comparable(side: CompareText): CompareText {
  if (side.text.length > MAX_COMPARE_CHARS) throw new Error('Texts larger than 8 MiB cannot be compared.');
  return side;
}

let latestOpen = 0;

/**
 * Opens the compare dialog with the side it was invoked from. A side still
 * loading when another is opened is dropped, so a slow fetch cannot replace
 * the text the dialog is already showing.
 */
export function openCompare(load: () => Promise<CompareText> | CompareText): void {
  const request = ++latestOpen;
  void Promise.resolve()
    .then(load)
    .then((side) => {
      if (request === latestOpen) useUiStore.getState().setCompareSource(comparable(side));
    })
    .catch((error: unknown) => {
      if (request === latestOpen) showErrorToast(error);
    });
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });

export function historyCompareLabel(session: SessionLogSummary): string {
  return `${sessionLogName(session)} · ${DATE_FORMAT.format(new Date(session.startedAt))}`;
}

/** A session history record as its clean log, without timestamps. */
export async function historyCompareText(session: SessionLogSummary): Promise<CompareText> {
  const response = await apiFetchRaw(`/api/session-history/${session.id}/clean`);
  return { label: historyCompareLabel(session), text: await response.text() };
}

export async function remoteFileCompareText(connId: string, host: string, path: string): Promise<CompareText> {
  const file = await apiFetch<SftpFileResponse>(`/api/sftp/${connId}/file?path=${encodeURIComponent(path)}`);
  return { label: `${host}:${file.path}`, text: file.content, remote: { connId, host, path: file.path } };
}

export function terminalCompareText(title: string, text: string, selection: boolean): CompareText {
  return { label: `${title} (${selection ? 'selection' : 'terminal output'})`, text };
}
