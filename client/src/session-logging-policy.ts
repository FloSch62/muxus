import type {
  SessionLoggingPolicy,
  SessionLoggingPolicyInput,
} from '@muxus/shared';

export interface HostSessionLoggingDraft extends Required<SessionLoggingPolicyInput> {
  /** Inherit the application default instead of storing a host override. */
  inherit: boolean;
  /** Prevent saving before the effective server policy has been loaded. */
  loaded: boolean;
}

export const FALLBACK_SESSION_LOGGING_POLICY: Required<SessionLoggingPolicyInput> = {
  enabled: false,
  captureInput: false,
  maxPartBytes: 5 * 1024 * 1024,
  maxParts: 10,
  logToFile: false,
};

export function blankHostSessionLoggingDraft(): HostSessionLoggingDraft {
  return {
    ...FALLBACK_SESSION_LOGGING_POLICY,
    inherit: true,
    loaded: false,
  };
}

export function hostSessionLoggingDraft(
  policy: SessionLoggingPolicy,
  inherit: boolean,
): HostSessionLoggingDraft {
  return {
    enabled: policy.enabled,
    captureInput: policy.captureInput,
    maxPartBytes: policy.maxPartBytes,
    maxParts: policy.maxParts,
    logToFile: policy.logToFile,
    inherit,
    loaded: true,
  };
}

/** Whether two drafts would save the same policy; fields of an inherited one do not count. */
export function sameSessionLoggingDraft(
  a: HostSessionLoggingDraft,
  b: HostSessionLoggingDraft,
): boolean {
  if (a.inherit !== b.inherit) return false;
  return (
    a.inherit ||
    (a.enabled === b.enabled &&
      a.captureInput === b.captureInput &&
      a.maxPartBytes === b.maxPartBytes &&
      a.maxParts === b.maxParts &&
      a.logToFile === b.logToFile)
  );
}

export function sessionLoggingPolicyInput(
  draft: HostSessionLoggingDraft,
): SessionLoggingPolicyInput {
  return {
    enabled: draft.enabled,
    captureInput: draft.captureInput,
    maxPartBytes: draft.maxPartBytes,
    maxParts: draft.maxParts,
    logToFile: draft.logToFile,
  };
}
