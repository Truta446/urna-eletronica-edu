import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { getOperator } from '../../../shared/http/operator-auth.js';
import { electionIdParams } from '../../../shared/validation.js';
import type { TallyService } from '../application/tally.service.js';

export function registerTallyRoutes(
  app: FastifyInstance,
  deps: { tally: TallyService; requireAdmin: onRequestAsyncHookHandler },
): void {
  const { tally, requireAdmin } = deps;

  app.post('/admin/elections/:id/tally', { onRequest: requireAdmin }, async (request, reply) => {
    const { id } = electionIdParams.parse(request.params);
    await tally.tally(id, getOperator(request));
    return reply.status(201).send(await tally.published(id));
  });

  app.get('/elections/:id/tally', async (request) => {
    const { id } = electionIdParams.parse(request.params);
    return tally.published(id);
  });

  app.get('/elections/:id/ballots', async (request) => {
    const { id } = electionIdParams.parse(request.params);
    return { ballots: await tally.publishedBallots(id) };
  });
}
