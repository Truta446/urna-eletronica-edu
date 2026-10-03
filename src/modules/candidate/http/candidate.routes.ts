import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { displayName, electionIdParams } from '../../../shared/validation.js';
import type { CandidateService } from '../application/candidate.service.js';
import { MAX_CANDIDATE_NUMBER, MIN_CANDIDATE_NUMBER } from '../domain/candidate.js';
import { getOperator } from '../../../shared/http/operator-auth.js';

const createCandidateBody = z.strictObject({
  // Sem coerção: "42" (string) é rejeitado; o contrato é número inteiro.
  number: z.number().int().min(MIN_CANDIDATE_NUMBER).max(MAX_CANDIDATE_NUMBER),
  name: displayName,
});

export function registerCandidateRoutes(
  app: FastifyInstance,
  deps: { candidates: CandidateService; requireAdmin: onRequestAsyncHookHandler },
): void {
  const { candidates, requireAdmin } = deps;

  app.post(
    '/admin/elections/:id/candidates',
    { onRequest: requireAdmin },
    async (request, reply) => {
      const { id } = electionIdParams.parse(request.params);
      const body = createCandidateBody.parse(request.body);
      return reply.status(201).send(await candidates.create(id, body, getOperator(request)));
    },
  );

  app.get('/elections/:id/candidates', async (request) => {
    const { id } = electionIdParams.parse(request.params);
    return { candidates: await candidates.list(id) };
  });
}
