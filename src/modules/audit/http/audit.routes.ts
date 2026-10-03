import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { AuditReader, ListedAuditEvent } from '../application/audit-log.js';

const listQuery = z.strictObject({
  electionId: z.uuid().optional(),
  afterId: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Sem electionId: todas as cadeias + completude. Com electionId: só a cadeia dela (e âncora opcional). */
const verifyQuery = z
  .strictObject({
    electionId: z.uuid().optional(),
    anchorSeq: z.coerce.number().int().min(1).optional(),
    anchorHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine((q) => (q.anchorSeq === undefined) === (q.anchorHash === undefined), {
    message: 'anchorSeq and anchorHash must be given together',
  })
  .refine((q) => q.anchorSeq === undefined || q.electionId !== undefined, {
    message: 'an anchor refers to one election chain: electionId is required',
  });

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function toResponse(event: ListedAuditEvent) {
  return {
    id: event.id,
    chainKey: event.chainKey,
    seq: event.seq,
    format: event.format,
    eventType: event.eventType,
    actorType: event.actorType,
    actorIdentifier: event.actorIdentifier,
    electionId: event.electionId,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
    previousHash: hex(event.previousHash),
    eventHash: hex(event.eventHash),
  };
}

export function registerAuditRoutes(
  app: FastifyInstance,
  deps: { audit: AuditReader; requireAdmin: onRequestAsyncHookHandler },
): void {
  const { audit, requireAdmin } = deps;

  app.get('/admin/audit', { onRequest: requireAdmin }, async (request) => {
    const query = listQuery.parse(request.query);
    const events = await audit.list({
      afterId: query.afterId,
      limit: query.limit,
      ...(query.electionId && { electionId: query.electionId }),
    });
    return { events: events.map(toResponse), nextAfterId: events.at(-1)?.id ?? null };
  });

  app.get('/admin/audit/verify', { onRequest: requireAdmin }, async (request) => {
    const { electionId, anchorSeq, anchorHash } = verifyQuery.parse(request.query);
    if (!electionId) return audit.verifyAll();
    const chain = await audit.chainKeyFor(electionId);
    const anchor =
      anchorSeq !== undefined && anchorHash ? { seq: anchorSeq, hash: anchorHash } : undefined;
    return { chain, ...(await audit.verifyChain(chain, anchor ? { anchor } : {})) };
  });
}
