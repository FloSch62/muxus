import { sessionLogName, type SessionLogSummary, type SftpFileResponse } from '@muxus/shared';
import { apiFetch, apiFetchRaw } from './api/http.js';

/** One side of the compare dialog. */
export interface CompareText {
  label: string;
  text: string;
  /** A file read over SFTP, so a second file on that connection starts from its path. */
  remote?: { connId: string; host: string; path: string };
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
