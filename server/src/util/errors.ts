import type { FastifyReply } from 'fastify';
import type { ApiErrorBody } from '@muxus/shared';

/** Throwable that carries the HTTP status a route should answer with. */
export class HttpProblem extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Send a structured error body, mapping unknown failures to 500. */
export async function sendError(reply: FastifyReply, err: unknown): Promise<void> {
  const status = err instanceof HttpProblem ? err.status : 500;
  const body: ApiErrorBody = {
    message: err instanceof Error ? err.message : String(err),
    ...(err instanceof HttpProblem && err.code ? { code: err.code } : {}),
  };
  await reply.code(status).send(body);
}
