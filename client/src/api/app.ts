import type { UpdateCheckResult } from '@muxus/shared';
import { apiFetch } from './http.js';

export async function checkForUpdate(options?: { force?: boolean }): Promise<UpdateCheckResult> {
  const desktop = window.muxusDesktop;
  if (desktop) return desktop.checkForUpdate(options);
  return apiFetch<UpdateCheckResult>(`/api/app/update-check${options?.force ? '?force=true' : ''}`);
}
