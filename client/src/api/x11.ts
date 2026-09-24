import { useQuery } from '@tanstack/react-query';
import type { X11SettingsUpdate, X11Status } from '@muxus/shared';
import { apiFetch } from './http.js';

export const X11_STATUS_KEY = ['x11-status'] as const;

/** Where forwarded windows open and the effective X11 settings; live, so a newly installed X server shows up. */
export function useX11Status() {
  return useQuery({
    queryKey: X11_STATUS_KEY,
    queryFn: () => apiFetch<X11Status>('/api/x11'),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
}

/** Tell the server the application's X11 settings; idempotent. */
export function putX11Settings(settings: X11SettingsUpdate): Promise<X11Status> {
  return apiFetch<X11Status>('/api/x11/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  });
}
