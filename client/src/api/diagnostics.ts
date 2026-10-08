import type {
  ConnectionDiagnosticsResponse,
  SshProfile,
  TelnetProfile,
} from '@muxus/shared';
import { apiFetch } from './http.js';

/** Run the backend's network checks against a session's first hop. */
export function diagnoseConnection(
  profile: SshProfile | TelnetProfile,
  signal?: AbortSignal,
): Promise<ConnectionDiagnosticsResponse> {
  return apiFetch<ConnectionDiagnosticsResponse>('/api/diagnostics/connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile }),
    signal,
  });
}
