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
  /** v2: chave pública X25519 em base64url (gerada por `npm run trustees:keygen`). */
  encryptionPublicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'Must be a 32-byte key in base64url')
    .transform((value) => Buffer.from(value, 'base64url'))
    .optional(),
});

export function toElectionResponse(election: Election) {
  return {
    id: election.id,
    name: election.name,
    status: election.status,
    startsAt: election.startsAt.toISOString(),
    endsAt: election.endsAt.toISOString(),
    createdAt: election.createdAt.toISOString(),
    ballotEncryption: election.encryptionPublicKey ? 'HPKE-X25519-HKDFSHA256-AES256GCM' : 'NONE',
    encryptionPublicKey: election.encryptionPublicKey
      ? Buffer.from(election.encryptionPublicKey).toString('base64url')
      : null,
  };
}

export function registerElectionRoutes(
  app: FastifyInstance,
  deps: { elections: ElectionService; requireAdmin: onRequestAsyncHookHandler },
): void {
  const { elections, requireAdmin } = deps;

  app.post('/admin/elections', { onRequest: requireAdmin }, async (request, reply) => {
    const { encryptionPublicKey, ...body } = createElectionBody.parse(request.body);
    const election = await elections.create(
      { ...body, ...(encryptionPublicKey && { encryptionPublicKey }) },
      getOperator(request),
    );
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
