import type {
  SessionLoggingPolicy,
  SessionLoggingPolicyInput,
} from '@muxus/shared';

export interface HostSessionLoggingDraft extends SessionLoggingPolicyInput {
  /** Inherit the application default instead of storing a host override. */
  inherit: boolean;
  /** Prevent saving before the effective server policy has been loaded. */
  loaded: boolean;
}

export const FALLBACK_SESSION_LOGGING_POLICY: SessionLoggingPolicyInput = {
  enabled: false,
  captureInput: false,
  maxPartBytes: 5 * 1024 * 1024,
  maxParts: 10,
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
    inherit,
    loaded: true,
  };
}

export function sessionLoggingPolicyInput(
  draft: HostSessionLoggingDraft,
): SessionLoggingPolicyInput {
  return {
    enabled: draft.enabled,
    captureInput: draft.captureInput,
    maxPartBytes: draft.maxPartBytes,
    maxParts: draft.maxParts,
  };
}
