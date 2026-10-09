import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY,
  type PasswordVaultStatus,
  type SendVaultSecretResult,
  type VaultSecretSaveResult,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import {
  CredentialVaultCorruptError,
  InvalidMasterPasswordError,
  InvalidMasterPasswordFormatError,
  InvalidSavedPasswordFormatError,
  InvalidVaultSecretError,
  VAULT_SECRET_NAME_MAX_LENGTH,
  VAULT_SECRET_USERNAME_MAX_LENGTH,
  VaultAlreadyConfiguredError,
  VaultAutomaticAccessError,
  VaultNotConfiguredError,
  VaultPolicyMismatchError,
  VaultSecretNameTakenError,
  VaultUnlockRequiredError,
} from '../security/password-vault.js';
import { typeVaultSecret } from '../security/vault-secret-input.js';
import type { TerminalInputWriter } from '../ws/terminal-inputs.js';
import { VaultKeyStoreUnavailableError } from '../security/vault-key-store.js';
import { HttpProblem, sendError } from '../util/errors.js';

const passwordSchema = z.object({
  password: z.string().min(1).max(1024),
  unlockPolicy: z
    .enum(['never', 'startup', 'credential'])
    .default(DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY),
});

const managementSchema = z.object({
  masterPassword: z.string().min(1).max(1024),
});

const updateCredentialSchema = managementSchema.extend({
  password: z.string().max(8192),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  nextPassword: z.string().min(1).max(1024),
});

const changeUnlockPolicySchema = managementSchema.extend({
  unlockPolicy: z.enum(['never', 'startup', 'credential']),
});

// Lengths are checked again, in characters, by the vault itself.
const secretSchema = managementSchema.extend({
  name: z.string().max(VAULT_SECRET_NAME_MAX_LENGTH * 4),
  username: z.string().max(VAULT_SECRET_USERNAME_MAX_LENGTH * 4).optional(),
  value: z.string().max(8192).optional(),
});

const sendSecretSchema = z.object({
  terminalIds: z.array(z.string().min(1).max(200)).min(1).max(256),
  enter: z.boolean(),
  masterPassword: z.string().min(1).max(1024).optional(),
});

/** Master-password lifecycle and saved-credential management. */
export function registerPasswordVaultRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  app.get('/api/password-vault', (): PasswordVaultStatus => ctx.vault.status());

  app.post('/api/password-vault/create', async (req, reply) => {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'A valid master password is required.' });
    }
    try {
      await ctx.vault.create(
        parsed.data.password,
        parsed.data.unlockPolicy,
      );
      return ctx.vault.status();
    } catch (err) {
      return sendVaultError(reply, err);
    }
  });

  app.post('/api/password-vault/repair-automatic-access', async (req, reply) => {
    const parsed = managementSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'A valid master password is required.' });
    }
    try {
      await ctx.vault.repairAutomaticAccess(parsed.data.masterPassword);
      return ctx.vault.status();
    } catch (err) {
      return sendVaultError(reply, err);
    }
  });

  app.post('/api/password-vault/unlock', async (req, reply) => {
    const parsed = managementSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ message: 'A valid master password is required.' });
    }
    try {
      await ctx.vault.unlockForSession(parsed.data.masterPassword);
      return ctx.vault.status();
    } catch (err) {
      return sendVaultError(reply, err);
    }
  });

  app.put('/api/password-vault/unlock-policy', async (req, reply) => {
    const parsed = changeUnlockPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'A valid master password and unlock policy are required.',
      });
    }
    try {
      await ctx.vault.changeUnlockPolicy(
        parsed.data.masterPassword,
        parsed.data.unlockPolicy,
      );
      return ctx.vault.status();
    } catch (err) {
      return sendVaultError(reply, err);
    }
  });

  app.post('/api/password-vault/change-master-password', async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Current and new master passwords are required.' });
    }
    try {
      await ctx.vault.changeMasterPassword(
        parsed.data.currentPassword,
        parsed.data.nextPassword,
      );
      return ctx.vault.status();
    } catch (err) {
      return sendVaultError(reply, err);
    }
  });

  app.post('/api/password-vault/credentials/:id/reveal', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = managementSchema.safeParse(req.body);
    if (!validCredentialId(id) || !parsed.success) {
      return reply.code(400).send({ message: 'A valid credential and master password are required.' });
    }
    try {
      const password = await ctx.vault.revealCredential(
        id,
        parsed.data.masterPassword,
      );
      if (password === undefined) {
        return reply.code(404).send({ message: 'Saved password not found.' });
      }
      return reply
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .send({ password });
    } catch (err) {
      return sendVaultError(reply, err);
    }
  });

  app.put('/api/password-vault/credentials/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateCredentialSchema.safeParse(req.body);
    if (!validCredentialId(id) || !parsed.success) {
      return reply.code(400).send({ message: 'A valid credential, master password and password are required.' });
    }
    try {
      const updated = await ctx.vault.updateCredential(
        id,
        parsed.data.masterPassword,
        parsed.data.password,
      );
      if (!updated) {
        return reply.code(404).send({ message: 'Saved password not found.' });
      }
      return ctx.vault.status();
    } catch (err) {
      return sendVaultError(reply, err);
    }
  });

  app.delete('/api/password-vault/credentials/:id', (req) => {
    const { id } = req.params as { id: string };
    return {
      deleted: validCredentialId(id) && ctx.vault.deleteCredential(id),
    };
  });

  app.post('/api/password-vault/secrets', async (req, reply) => {
    const parsed = secretSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.value === undefined) {
      return reply.code(400).send({ message: 'A name, a secret and the master password are required.' });
    }
    try {
      const secret = await ctx.vault.createSecret(
        { name: parsed.data.name, username: parsed.data.username, value: parsed.data.value },
        parsed.data.masterPassword,
      );
      return { secret, status: ctx.vault.status() } satisfies VaultSecretSaveResult;
    } catch (err) {
      return sendVaultError(reply, err);
    }
  });

  app.put('/api/password-vault/secrets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = secretSchema.safeParse(req.body);
    if (!validCredentialId(id) || !parsed.success) {
      return reply.code(400).send({ message: 'A valid secret, name and master password are required.' });
    }
    try {
      const secret = await ctx.vault.updateSecret(
        id,
        { name: parsed.data.name, username: parsed.data.username, value: parsed.data.value },
        parsed.data.masterPassword,
      );
      if (!secret) return sendSecretMissing(reply);
      return { secret, status: ctx.vault.status() } satisfies VaultSecretSaveResult;
    } catch (err) {
      return sendVaultError(reply, err);
    }
  });

  // Types a secret into live sessions on the backend, so the value never
  // reaches the renderer, the request log, session history or a log file.
  app.post('/api/password-vault/secrets/:id/send', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = sendSecretSchema.safeParse(req.body);
    if (!validCredentialId(id) || !parsed.success) {
      return reply.code(400).send({ message: 'A valid secret and terminal session are required.' });
    }
    if (!ctx.vault.hasSecret(id)) return sendSecretMissing(reply);
    const writers = [...new Set(parsed.data.terminalIds)]
      .map((terminalId) => ctx.terminalInputs.writer(terminalId))
      .filter((writer): writer is TerminalInputWriter => writer !== undefined);
    if (writers.length === 0) {
      return sendError(
        reply,
        new HttpProblem(409, 'The session is no longer connected.', 'terminal-unavailable'),
      );
    }
    try {
      const sent = await typeVaultSecret(ctx.vault, id, writers, {
        enter: parsed.data.enter,
        masterPassword: parsed.data.masterPassword,
      });
      if (sent === undefined) return sendSecretMissing(reply);
      if (sent === 0) {
        return sendError(
          reply,
          new HttpProblem(409, 'The session is no longer connected.', 'terminal-unavailable'),
        );
      }
      return reply.header('cache-control', 'no-store').send({ sent } satisfies SendVaultSecretResult);
    } catch (err) {
      if (err instanceof CredentialVaultCorruptError) {
        return sendError(reply, new HttpProblem(422, 'The saved secret could not be decrypted.', 'vault-secret-corrupt'));
      }
      return sendVaultError(reply, err);
    }
  });

  app.delete('/api/password-vault', async (): Promise<PasswordVaultStatus> => {
    // Intentionally master-password-free: reset is the recovery path when the
    // password is forgotten. This endpoint can only delete, never reveal data.
    await ctx.vault.deleteAll();
    return ctx.vault.status();
  });
}

function validCredentialId(id: string): boolean {
  return id.length > 0 && id.length <= 200;
}

function sendSecretMissing(reply: FastifyReply): Promise<void> {
  return sendError(
    reply,
    new HttpProblem(404, 'The secret is no longer in the password vault.', 'vault-secret-missing'),
  );
}

/** Shared vault → HTTP problem mapping (also used by the folder routes). */
export function sendVaultError(reply: FastifyReply, err: unknown): Promise<void> {
  if (err instanceof InvalidMasterPasswordError) {
    return sendError(reply, new HttpProblem(401, err.message, 'invalid-master-password'));
  }
  if (err instanceof InvalidMasterPasswordFormatError) {
    return sendError(reply, new HttpProblem(400, err.message, 'invalid-master-password-format'));
  }
  if (err instanceof VaultAlreadyConfiguredError) {
    return sendError(reply, new HttpProblem(409, err.message, 'vault-already-configured'));
  }
  if (err instanceof VaultNotConfiguredError) {
    return sendError(reply, new HttpProblem(409, err.message, 'vault-not-configured'));
  }
  if (err instanceof VaultPolicyMismatchError) {
    return sendError(
      reply,
      new HttpProblem(409, err.message, 'vault-policy-mismatch'),
    );
  }
  if (err instanceof VaultAutomaticAccessError) {
    return sendError(reply, new HttpProblem(423, err.message, 'vault-automatic-access-unavailable'));
  }
  if (err instanceof VaultUnlockRequiredError) {
    return sendError(reply, new HttpProblem(423, err.message, 'vault-locked'));
  }
  if (err instanceof InvalidVaultSecretError) {
    return sendError(reply, new HttpProblem(400, err.message, 'invalid-vault-secret'));
  }
  if (err instanceof VaultSecretNameTakenError) {
    return sendError(reply, new HttpProblem(409, err.message, 'vault-secret-name-taken'));
  }
  if (err instanceof InvalidSavedPasswordFormatError) {
    return sendError(reply, new HttpProblem(400, err.message, 'invalid-saved-password-format'));
  }
  if (err instanceof VaultKeyStoreUnavailableError) {
    return sendError(
      reply,
      new HttpProblem(503, err.message, 'os-key-store-unavailable'),
    );
  }
  return sendError(reply, err);
}
