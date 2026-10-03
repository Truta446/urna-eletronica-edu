import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { getOperator } from '../../../shared/http/operator-auth.js';
import { electionIdParams } from '../../../shared/validation.js';
import type { TallyService } from '../application/tally.service.js';

/** v2: partes dos trustees (base64url). O body nunca entra no log. */
const tallyBody = z
  .strictObject({
    trusteeShares: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{2,200}$/))
      .max(255)
      .optional(),
  })
  .optional();

export function registerTallyRoutes(
  app: FastifyInstance,
  deps: { tally: TallyService; requireAdmin: onRequestAsyncHookHandler },
): void {
  const { tally, requireAdmin } = deps;

  app.post('/admin/elections/:id/tally', { onRequest: requireAdmin }, async (request, reply) => {
    const { id } = electionIdParams.parse(request.params);
    const body = tallyBody.parse(request.body);
    await tally.tally(
      id,
      getOperator(request),
      body?.trusteeShares ? { trusteeShares: body.trusteeShares } : {},
    );
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
