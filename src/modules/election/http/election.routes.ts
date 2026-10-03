import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { displayName, electionIdParams, isoDateTime } from '../../../shared/validation.js';
import type { ElectionService } from '../application/election.service.js';
import type { Election } from '../domain/election.js';
import { getOperator } from '../../../shared/http/operator-auth.js';

const createElectionBody = z.strictObject({
  name: displayName,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
});

export function toElectionResponse(election: Election) {
  return {
    id: election.id,
    name: election.name,
    status: election.status,
    startsAt: election.startsAt.toISOString(),
    endsAt: election.endsAt.toISOString(),
    createdAt: election.createdAt.toISOString(),
  };
}

export function registerElectionRoutes(
  app: FastifyInstance,
  deps: { elections: ElectionService; requireAdmin: onRequestAsyncHookHandler },
): void {
  const { elections, requireAdmin } = deps;

  app.post('/admin/elections', { onRequest: requireAdmin }, async (request, reply) => {
    const body = createElectionBody.parse(request.body);
    const election = await elections.create(body, getOperator(request));
    return reply.status(201).send(toElectionResponse(election));
  });

  app.post('/admin/elections/:id/open', { onRequest: requireAdmin }, async (request) => {
    const { id } = electionIdParams.parse(request.params);
    return toElectionResponse(await elections.open(id, getOperator(request)));
  });

  app.post('/admin/elections/:id/close', { onRequest: requireAdmin }, async (request) => {
    const { id } = electionIdParams.parse(request.params);
    return toElectionResponse(await elections.close(id, getOperator(request)));
  });

  app.get('/elections/:id', async (request) => {
    const { id } = electionIdParams.parse(request.params);
    return toElectionResponse(await elections.get(id));
  });
}
