import { z } from 'zod';

/**
 * /ws/terminal framing (same convention as classic web terminals): binary
 * frames carry raw terminal bytes in both directions; text frames carry JSON
 * control messages. The client speaks first with `connect`; the server
 * answers with `ready` once a shell is attached, interleaving `auth-prompt`
 * / `host-key` round-trips before that for SSH sessions.
 */

/** Where a terminal session runs. Secrets (passwords, key passphrases) are
 *  never part of the profile — they travel only in `auth-response` replies. */
export const sessionProfileSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    /** Login shell override; empty/absent picks the server's default. */
    shell: z.string().optional(),
    cwd: z.string().optional(),
    /** TERM to advertise; the server defaults to xterm-kitty. */
    term: z.string().optional(),
  }),
  z.object({
    kind: z.literal('ssh'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    user: z.string().optional(),
    /** agent = SSH agent, key = private key file, password = interactive. */
    auth: z.enum(['agent', 'key', 'password']).optional(),
    keyPath: z.string().optional(),
    term: z.string().optional(),
  }),
]);
export type SessionProfile = z.infer<typeof sessionProfileSchema>;
export type SshProfile = Extract<SessionProfile, { kind: 'ssh' }>;
export type LocalProfile = Extract<SessionProfile, { kind: 'local' }>;

/** Text frames the client sends on /ws/terminal. */
export const terminalClientMessageSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('connect'),
    profile: sessionProfileSchema,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ op: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  /** Answers to the last `auth-prompt`, in prompt order. */
  z.object({ op: z.literal('auth-response'), answers: z.array(z.string()) }),
  /** Verdict on the last `host-key` challenge. */
  z.object({ op: z.literal('host-key-response'), accept: z.boolean() }),
]);
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;

/** Text frames the server sends on /ws/terminal. */
export type TerminalServerMessage =
  /** Connection progress worth echoing into the terminal ("Connecting …"). */
  | { op: 'status'; message: string }
  /** Interactive auth (password, 2FA, key passphrase). echo=false → mask input. */
  | { op: 'auth-prompt'; name?: string; instructions?: string; prompts: Array<{ prompt: string; echo: boolean }> }
  /** Host key verification: `new` = first contact (TOFU), `mismatch` = KEY CHANGED. */
  | {
      op: 'host-key';
      host: string;
      port: number;
      keyType: string;
      /** SHA256:… fingerprint, OpenSSH presentation. */
      fingerprint: string;
      state: 'new' | 'mismatch';
      /** Previously recorded fingerprint when state is `mismatch`. */
      previous?: string;
    }
  /** Shell attached; connId keys follow-up SFTP/forward REST calls. */
  | { op: 'ready'; connId: string }
  | { op: 'exit'; code?: number; message?: string };
