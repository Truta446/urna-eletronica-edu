import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError } from '../../../shared/errors/app-error.js';
import { extractBearerToken } from '../../../shared/http/operator-auth.js';
import type { BallotService } from '../application/ballot.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    votingToken?: string;
  }
}

const choiceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('candidate'), number: z.number().int().min(1).max(99_999) }),
  z.strictObject({ type: z.literal('blank') }),
  z.strictObject({ type: z.literal('null') }),
]);

const castBallotBody = z.strictObject({ electionId: z.uuid(), choice: choiceSchema });

/** Gerada pelo cliente, uma por intenção de voto. UUID é o formato recomendado. */
const idempotencyHeaders = z.object({
  'idempotency-key': z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'Invalid Idempotency-Key'),
});

/** Antes do parse do body: sem token bem formado, o servidor não processa payload algum. */
function requireVotingToken(request: FastifyRequest): Promise<void> {
  const token = extractBearerToken(request.headers.authorization);
  if (!token) return Promise.reject(new UnauthorizedError('Invalid or expired voting token'));
  request.votingToken = token;
  return Promise.resolve();
}

export function registerBallotRoutes(app: FastifyInstance, deps: { ballots: BallotService }): void {
  app.post('/ballots', { onRequest: requireVotingToken }, async (request, reply) => {
    const token = request.votingToken;
    if (!token) throw new UnauthorizedError('Invalid or expired voting token');
    const headers = idempotencyHeaders.parse(request.headers);
    const body = castBallotBody.parse(request.body);

    const result = await deps.ballots.cast({
      token,
      idempotencyKey: headers['idempotency-key'],
      electionId: body.electionId,
      choice: body.choice,
    });

    return reply
      .status(result.status)
      .header('cache-control', 'no-store')
      .header('idempotent-replayed', String(result.replayed))
      .send(result.body);
  });
}
