import { create } from 'zustand';

interface BackendState {
  /** The local Muxus server did not answer a fetch at all. */
  unreachable: boolean;
  /** The server answered 401 — the session token is no longer valid. */
  authInvalid: boolean;
}

export const useBackendStore = create<BackendState>()(() => ({
  unreachable: false,
  authInvalid: false,
}));

export function reportBackendDown(): void {
  if (!useBackendStore.getState().unreachable) useBackendStore.setState({ unreachable: true });
}

export function reportBackendUp(): void {
  if (useBackendStore.getState().unreachable) useBackendStore.setState({ unreachable: false });
}

export function reportAuthInvalid(): void {
  if (!useBackendStore.getState().authInvalid) useBackendStore.setState({ authInvalid: true });
}
