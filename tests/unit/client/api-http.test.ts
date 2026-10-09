import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../client/src/api/http.js';
import { useBackendStore } from '../../../client/src/state/backend.js';

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

beforeEach(() => {
  useBackendStore.setState({ unreachable: false, authInvalid: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api requests answered with 401', () => {
  it('keep the session when only the vault master password was wrong', async () => {
    answer(401, { message: 'The master password is incorrect.', code: 'invalid-master-password' });
    const error = await apiFetch('/api/password-vault/secrets/s1/send').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).body?.code).toBe('invalid-master-password');
    expect(useBackendStore.getState().authInvalid).toBe(false);
  });

  it('report a session token the backend no longer accepts', async () => {
    answer(401, { message: 'unauthorized' });
    await expect(apiFetch('/api/app/info')).rejects.toBeInstanceOf(ApiError);
    expect(useBackendStore.getState().authInvalid).toBe(true);
  });
});
