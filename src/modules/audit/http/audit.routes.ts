import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { AuditReader } from '../application/audit-log.js';
import type { StoredAuditEvent } from '../domain/audit-chain.js';

const listQuery = z.strictObject({
  electionId: z.uuid().optional(),
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const verifyQuery = z
  .strictObject({
    anchorSeq: z.coerce.number().int().min(1).optional(),
    anchorHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine((q) => (q.anchorSeq === undefined) === (q.anchorHash === undefined), {
    message: 'anchorSeq and anchorHash must be given together',
  });

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function toResponse(event: StoredAuditEvent) {
  return {
    seq: event.seq,
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
      afterSeq: query.afterSeq,
      limit: query.limit,
      ...(query.electionId && { electionId: query.electionId }),
    });
    return { events: events.map(toResponse), nextAfterSeq: events.at(-1)?.seq ?? null };
  });

  app.get('/admin/audit/verify', { onRequest: requireAdmin }, async (request) => {
    const { anchorSeq, anchorHash } = verifyQuery.parse(request.query);
    const anchor =
      anchorSeq !== undefined && anchorHash ? { seq: anchorSeq, hash: anchorHash } : undefined;
    return audit.verify(anchor ? { anchor } : {});
  });
}
