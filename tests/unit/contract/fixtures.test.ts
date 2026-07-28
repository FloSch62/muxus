import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  sessionProfileSchema,
  terminalClientMessageSchema,
} from '@muxus/shared/ws-protocol';

// Shared fixtures also consumed by the Go mirror (app/internal/api). A schema
// change here without a fixture update fails exactly one side, which is the
// point: both implementations must accept and reject the same payloads.
const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../contract/fixtures',
);

interface Fixture {
  name: string;
  valid: boolean;
  data: unknown;
  normalized?: unknown;
}

function load(file: string): Fixture[] {
  return JSON.parse(readFileSync(path.join(fixturesDir, file), 'utf8')) as Fixture[];
}

describe('session profile fixtures', () => {
  for (const fixture of load('session-profiles.json')) {
    it(fixture.name, () => {
      const result = sessionProfileSchema.safeParse(fixture.data);
      expect(result.success).toBe(fixture.valid);
      if (result.success && fixture.normalized) {
        expect(result.data).toEqual(fixture.normalized);
      }
    });
  }
});

describe('terminal client message fixtures', () => {
  for (const fixture of load('terminal-client-messages.json')) {
    it(fixture.name, () => {
      const result = terminalClientMessageSchema.safeParse(fixture.data);
      expect(result.success).toBe(fixture.valid);
      if (result.success && fixture.normalized) {
        expect(result.data).toEqual(fixture.normalized);
      }
    });
  }
});
