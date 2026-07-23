import { create } from 'zustand';

export type ToastSeverity = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  /** Distinguishes consecutive toasts so the snackbar's auto-hide timer restarts. */
  id: number;
  severity: ToastSeverity;
  message: string;
  /** Full error text behind the toast's Details expander / Copy button. */
  details?: string;
}

interface ToastState {
  toast: Toast | null;
  show: (severity: ToastSeverity, message: string, details?: string) => void;
  dismiss: () => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set) => ({
  toast: null,
  show: (severity, message, details) => set({ toast: { id: nextId++, severity, message, details } }),
  dismiss: () => set({ toast: null }),
}));

/** Show a transient notification from anywhere (components, mutation callbacks). */
export function showToast(severity: ToastSeverity, message: string, details?: string): void {
  useToastStore.getState().show(severity, message, details);
}

/**
 * Structured detail text for an error toast: HTTP status and response body
 * where present (duck-typed so this stays decoupled from ApiError), else the
 * stack. Returns undefined when there is nothing beyond the message.
 */
export function errorDetails(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const parts: string[] = [];
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status > 0) parts.push(`HTTP ${status}`);
  const body = (err as { body?: unknown }).body;
  if (body !== undefined) {
    try {
      parts.push(JSON.stringify(body, null, 2));
    } catch {
      // unserializable body — skip
    }
  }
  if (!parts.length && err.stack) parts.push(err.stack);
  const text = parts.join('\n');
  return text && text !== err.message ? text : undefined;
}

/** Error toast for a caught value, attaching structured details when available. */
export function showErrorToast(err: unknown): void {
  showToast('error', err instanceof Error ? err.message : String(err), errorDetails(err));
}
