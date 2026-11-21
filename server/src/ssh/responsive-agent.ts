import { agentIdentities, agentSign, isSshError } from './engine.js';
import {
  identityFromBlob,
  isUsableIdentityType,
  type SigningOptions,
  type SshAgent,
  type SshIdentity,
} from './identity.js';
import { isSecurityKeyType, SecurityKeyError, signatureAlgorithm } from './security-keys.js';

export const DEFAULT_AGENT_WAIT_STATUS_MS = 2_000;
export const DEFAULT_AGENT_OPERATION_TIMEOUT_MS = 30_000;
/** A security key waits for a touch (and maybe its PIN), which is user time. */
export const DEFAULT_SECURITY_KEY_TIMEOUT_MS = 120_000;

export interface ResponsiveAgentOptions {
  /** Agent interaction is user time (approval/touch), not network dial time. */
  pauseDeadline?: () => void;
  resumeDeadline?: () => void;
  /** Called once when an operation takes long enough to need user action. */
  onWaiting?: (operation: 'identities' | 'sign') => void;
  waitStatusMs?: number;
  operationTimeoutMs?: number;
  /** Called as a signature with a security key starts; it waits for a touch. */
  onSecurityKey?: (key: SshIdentity) => void;
  /** Bound for a security key signature; 0 waits as long as the agent does. */
  securityKeyTimeoutMs?: number;
  /** Called with the signature algorithm of every signature the agent made. */
  onSignature?: (algorithm: string) => void;
}

/** The agent protocol's flags for the RSA signature variants. */
const RSA_SHA2_256 = 2;
const RSA_SHA2_512 = 4;

/** Failures that say the agent itself is not there, rather than that it said no. */
const AGENT_GONE = ['AGENT_UNAVAILABLE', 'AGENT_TIMEOUT', 'AGENT_CLOSED', 'AGENT_PROTOCOL'];

/**
 * An ssh-agent that never hangs a login. Every request runs over a
 * connection of its own with a time limit, so an agent that accepts a
 * connection but never replies costs that one request. `endpoint` is the
 * agent's socket path, a Windows pipe, or `pageant`.
 */
export class ResponsiveAgent implements SshAgent {
  private unavailableError: Error | undefined;

  constructor(
    readonly endpoint: string,
    private readonly options: ResponsiveAgentOptions = {},
  ) {}

  /** The agent could not be reached; it is not asked again. */
  get unavailable(): boolean {
    return this.unavailableError !== undefined;
  }

  async identities(): Promise<SshIdentity[]> {
    const listed = await this.request('identities', (timeoutMs) => agentIdentities(this.endpoint, timeoutMs));
    // Identities of a type the engine cannot offer are left out, so nothing
    // lists or tries a key that could never log in.
    return listed.flatMap((entry) => {
      const identity = identityFromBlob(entry.blob, entry.comment);
      return identity && isUsableIdentityType(identity.type) ? [identity] : [];
    });
  }

  async sign(identity: SshIdentity, data: Buffer, options: SigningOptions = {}): Promise<Buffer> {
    const securityKey = isSecurityKeyType(identity.type);
    if (securityKey) this.options.onSecurityKey?.(identity);
    const flags = options.hash === 'sha512' ? RSA_SHA2_512 : options.hash === 'sha256' ? RSA_SHA2_256 : 0;
    try {
      const signature = await this.request(
        'sign',
        (timeoutMs) => agentSign(this.endpoint, identity.blob, data, flags, timeoutMs),
        securityKey
          ? {
              waitStatusMs: -1,
              timeoutMs: this.options.securityKeyTimeoutMs ?? DEFAULT_SECURITY_KEY_TIMEOUT_MS,
            }
          : undefined,
      );
      this.options.onSignature?.(signatureAlgorithm(identity.type, options.hash));
      return signature;
    } catch (err) {
      if (securityKey && !(err instanceof SecurityKeyError)) {
        throw new SecurityKeyError(err instanceof Error ? err.message : String(err), identity);
      }
      throw err;
    }
  }

  private async request<T>(
    operation: 'identities' | 'sign',
    send: (timeoutMs: number) => Promise<T>,
    limits?: { waitStatusMs: number; timeoutMs: number },
  ): Promise<T> {
    if (this.unavailableError) throw this.unavailableError;
    const waitStatusMs = limits?.waitStatusMs ?? this.options.waitStatusMs ?? DEFAULT_AGENT_WAIT_STATUS_MS;
    const operationTimeoutMs =
      limits?.timeoutMs ?? this.options.operationTimeoutMs ?? DEFAULT_AGENT_OPERATION_TIMEOUT_MS;
    const waitTimer =
      waitStatusMs >= 0 ? setTimeout(() => this.options.onWaiting?.(operation), waitStatusMs) : undefined;
    waitTimer?.unref?.();

    this.options.pauseDeadline?.();
    try {
      return await send(Math.max(0, operationTimeoutMs));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // An agent that cannot list its keys is of no use for the rest of the login either.
      if (isSshError(error, ...AGENT_GONE) || operation === 'identities') this.unavailableError = error;
      throw error;
    } finally {
      if (waitTimer) clearTimeout(waitTimer);
      this.options.resumeDeadline?.();
    }
  }
}
