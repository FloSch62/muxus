import { AgentProtocol, BaseAgent, type ParsedKey, type SigningRequestOptions } from 'ssh2';

export const DEFAULT_AGENT_WAIT_STATUS_MS = 2_000;
export const DEFAULT_AGENT_OPERATION_TIMEOUT_MS = 30_000;

export interface ResponsiveAgentOptions {
  /** Agent interaction is user time (approval/touch), not network dial time. */
  pauseDeadline?: () => void;
  resumeDeadline?: () => void;
  /** Called once when an operation takes long enough to need user action. */
  onWaiting?: (operation: 'identities' | 'sign') => void;
  waitStatusMs?: number;
  operationTimeoutMs?: number;
}

/**
 * Runs ssh-agent requests over streams we own, so an agent that accepts a
 * connection but never replies cannot trap ssh2's authentication state
 * machine forever. The wrapped agent still supplies the platform-specific
 * stream (OpenSSH socket, Cygwin or Pageant).
 */
export class ResponsiveAgent extends BaseAgent<ParsedKey> {
  private unavailableError: Error | undefined;

  constructor(
    private readonly agent: BaseAgent<ParsedKey>,
    private readonly options: ResponsiveAgentOptions = {},
  ) {
    super();
  }

  getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void): void {
    this.request(
      'identities',
      (protocol, done) => protocol.getIdentities(done),
      cb,
    );
  }

  sign(
    pubKey: ParsedKey,
    data: Buffer,
    options: SigningRequestOptions,
    cb?: (err?: Error | null, signature?: Buffer) => void,
  ): void;
  sign(
    pubKey: ParsedKey,
    data: Buffer,
    cb: (err?: Error | null, signature?: Buffer) => void,
  ): void;
  sign(
    pubKey: ParsedKey,
    data: Buffer,
    optionsOrCb:
      | SigningRequestOptions
      | ((err?: Error | null, signature?: Buffer) => void),
    maybeCb?: (err?: Error | null, signature?: Buffer) => void,
  ): void {
    const options =
      typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    if (!cb) return;
    this.request(
      'sign',
      (protocol, done) => {
        protocol.sign(pubKey, data, options, done);
      },
      cb,
    );
  }

  /** Agent forwarding remains a transparent stream, independent of login auth. */
  override getStream(cb: Parameters<NonNullable<BaseAgent['getStream']>>[0]): void {
    if (!this.agent.getStream) {
      cb(new Error('SSH agent does not support stream access'));
      return;
    }
    this.agent.getStream(cb);
  }

  private request<T>(
    operation: 'identities' | 'sign',
    send: (
      protocol: AgentProtocol,
      done: (err?: Error | null, value?: T) => void,
    ) => void,
    cb: (err: Error | undefined, value?: T) => void,
  ): void {
    if (this.unavailableError) {
      queueMicrotask(() => cb(this.unavailableError));
      return;
    }
    if (!this.agent.getStream) {
      queueMicrotask(() =>
        cb(new Error('SSH agent does not support stream access')),
      );
      return;
    }

    const waitStatusMs =
      this.options.waitStatusMs ?? DEFAULT_AGENT_WAIT_STATUS_MS;
    const operationTimeoutMs =
      this.options.operationTimeoutMs ?? DEFAULT_AGENT_OPERATION_TIMEOUT_MS;
    let settled = false;
    let stream: Awaited<Parameters<Parameters<NonNullable<BaseAgent['getStream']>>[0]>[1]>;
    let protocol: AgentProtocol | undefined;

    const waitTimer =
      waitStatusMs >= 0
        ? setTimeout(() => this.options.onWaiting?.(operation), waitStatusMs)
        : undefined;
    waitTimer?.unref?.();

    const finish = (
      err?: Error | null,
      value?: T,
      agentUnavailable = false,
    ) => {
      if (settled) return;
      settled = true;
      if (waitTimer) clearTimeout(waitTimer);
      clearTimeout(timeoutTimer);
      if (agentUnavailable && err) this.unavailableError = err;

      try {
        protocol?.unpipe(stream);
        stream?.unpipe(protocol);
        protocol?.destroy();
        stream?.destroy();
      } catch {
        // The operation result is already known; cleanup is best-effort.
      }
      this.options.resumeDeadline?.();
      cb(err ?? undefined, value);
    };

    const timeoutTimer = setTimeout(() => {
      finish(
        new Error(
          `SSH agent did not respond while ${
            operation === 'identities' ? 'listing identities' : 'signing'
          }`,
        ),
        undefined,
        true,
      );
    }, operationTimeoutMs);
    timeoutTimer.unref?.();

    this.options.pauseDeadline?.();
    try {
      this.agent.getStream((err, connectedStream) => {
        if (settled) {
          connectedStream?.destroy();
          return;
        }
        if (err || !connectedStream) {
          finish(err ?? new Error('Failed to connect to SSH agent'), undefined, true);
          return;
        }
        stream = connectedStream;
        protocol = new AgentProtocol(true);
        const onTransportFailure = (failure?: Error) => {
          finish(
            failure ?? new Error('SSH agent connection closed before replying'),
            undefined,
            true,
          );
        };
        protocol.once('error', onTransportFailure);
        stream.once('close', onTransportFailure);
        stream.once('end', onTransportFailure);
        stream.once('error', onTransportFailure);
        protocol.pipe(stream).pipe(protocol);
        try {
          send(protocol, (requestError, value) =>
            finish(requestError, value, operation === 'identities' && !!requestError),
          );
        } catch (requestError) {
          finish(
            requestError instanceof Error
              ? requestError
              : new Error(String(requestError)),
          );
        }
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)), undefined, true);
    }
  }
}
