import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { electionIdParams } from '../../../shared/validation.js';
import { voterIdentifier } from '../../voter/http/voter.routes.js';
import type { AuthorizationService } from '../application/authorization.service.js';
import { getOperator } from '../../../shared/http/operator-auth.js';

const authorizeVoterBody = z.strictObject({ voterIdentifier });

export function registerAuthorizationRoutes(
  app: FastifyInstance,
  deps: { authorization: AuthorizationService; requirePollWorker: onRequestAsyncHookHandler },
): void {
  const { authorization, requirePollWorker } = deps;

  app.post(
    '/elections/:id/voting-sessions',
    { onRequest: requirePollWorker },
    async (request, reply) => {
      const { id } = electionIdParams.parse(request.params);
      const body = authorizeVoterBody.parse(request.body);
      const issued = await authorization.authorize(id, body.voterIdentifier, getOperator(request));

      // A resposta carrega um segredo: nenhum cache intermediário pode guardá-la.
      return reply
        .status(201)
        .header('cache-control', 'no-store')
        .send({ token: issued.token, expiresAt: issued.expiresAt.toISOString() });
    },
  );
}
