import type { AuthPromptResponse, LoginSequence } from '@muxus/shared';
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from '@muxus/shared/ws-protocol';
import {
  CredentialVaultCorruptError,
  InvalidMasterPasswordError,
  InvalidMasterPasswordFormatError,
  VaultUnlockRequiredError,
  type PasswordVault,
} from '../security/password-vault.js';
import { typeVaultSecret } from '../security/vault-secret-input.js';
import type { TerminalInputWriter } from '../ws/terminal-inputs.js';
import {
  LoginSequenceRunner,
  type LoginSequenceProgress,
  type SecretStepResult,
} from './runner.js';

const MASTER_PASSWORD_ATTEMPTS = 3;

export interface LoginSequenceSessionOptions {
  sequence: LoginSequence;
  vault: PasswordVault;
  /** Types into the session's transport directly, never through session logging. */
  write: TerminalInputWriter;
  recorder: { input(data: Buffer): void; system(message: string): void };
  send(message: TerminalServerMessage): void;
  log?: { warn(details: object, message: string): void };
}

/**
 * A login sequence attached to one terminal session: it reports progress to
 * the tab, takes the tab's cancel, and asks for the vault's master password
 * over the session's own prompt round-trip when a step needs a locked vault.
 * Plain text it sends counts as typed input; a vault secret goes straight to
 * the transport, so session history and log files only ever hold what the
 * remote side echoes back.
 */
export class LoginSequenceSession {
  private readonly runner: LoginSequenceRunner;
  private answer: ((response: AuthPromptResponse | undefined) => void) | undefined;
  private started = false;

  constructor(private readonly options: LoginSequenceSessionOptions) {
    this.runner = new LoginSequenceRunner(
      options.sequence.steps,
      {
        write: options.write,
        typed: (data) => options.recorder.input(data),
        typeSecret: (secretId, enter, signal) => this.typeSecret(secretId, enter, signal),
        progress: (update) => this.report(update),
      },
      { secretName: (secretId) => this.secretName(secretId) },
    );
  }

  output(data: Uint8Array): void {
    this.runner.output(data);
  }

  /** Run the steps; output received since the session attached already counts. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runner.run().catch((err: unknown) => {
      this.options.log?.warn({ err }, 'login sequence failed');
    });
  }

  close(): void {
    this.runner.close();
    this.answer?.(undefined);
  }

  /** Frames meant for the sequence: a cancel, or the answer to its master-password prompt. */
  handleControl(message: TerminalClientMessage): boolean {
    if (message.op === 'cancel-login-sequence') {
      this.runner.cancel();
      return true;
    }
    if (message.op === 'auth-response' && this.answer) {
      this.answer({ answers: message.answers, skipped: message.skipped });
      return true;
    }
    return false;
  }

  private report(update: LoginSequenceProgress): void {
    this.options.send({ op: 'login-sequence', ...update });
    if (update.state === 'failed') {
      this.options.recorder.system(`Login sequence stopped: ${update.message ?? 'a step failed.'}`);
    } else if (update.state === 'cancelled') {
      this.options.recorder.system(`Login sequence cancelled at step ${update.step} of ${update.steps}.`);
    }
  }

  private secretName(secretId: string): string | undefined {
    return this.options.vault.secrets().find((secret) => secret.id === secretId)?.name;
  }

  private async typeSecret(
    secretId: string,
    enter: boolean,
    signal: AbortSignal,
  ): Promise<SecretStepResult> {
    let masterPassword: string | undefined;
    let error: string | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const typed = await typeVaultSecret(this.options.vault, secretId, [this.options.write], {
          enter,
          masterPassword,
        });
        if (typed === undefined) return 'its secret is no longer in the password vault.';
        return typed > 0 ? undefined : 'the session no longer takes input.';
      } catch (err) {
        if (err instanceof CredentialVaultCorruptError) return 'its secret could not be decrypted.';
        if (err instanceof InvalidMasterPasswordError || err instanceof InvalidMasterPasswordFormatError) {
          error = err.message;
        } else if (!(err instanceof VaultUnlockRequiredError)) {
          throw err;
        }
      }
      if (attempt >= MASTER_PASSWORD_ATTEMPTS) return 'the password vault stayed locked.';
      masterPassword = await this.askMasterPassword(secretId, error, signal);
      if (signal.aborted) return undefined;
      if (masterPassword === undefined) return 'the password vault stayed locked.';
    }
  }

  private askMasterPassword(
    secretId: string,
    error: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    const name = this.secretName(secretId) ?? 'a saved secret';
    const instructions = `The login sequence is about to type “${name}”. Enter the master password to use it.`;
    return new Promise((resolve) => {
      const done = (value: string | undefined) => {
        signal.removeEventListener('abort', onAbort);
        this.answer = undefined;
        resolve(value);
      };
      const onAbort = () => done(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      this.answer = (response) =>
        done(response && !response.skipped ? (response.answers[0] ?? '') : undefined);
      this.options.send({
        op: 'auth-prompt',
        name: 'Unlock password vault',
        purpose: 'vault-unlock',
        instructions: error ? `${error}\n\n${instructions}` : instructions,
        prompts: [{ prompt: 'Master password', echo: false }],
        skipLabel: 'Stop login sequence',
      });
    });
  }
}
