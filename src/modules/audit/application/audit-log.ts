import { z } from 'zod';
import type { PrismaClient } from '../../../database/client.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import {
  computeEventHash,
  createChainVerifier,
  GENESIS_HASH,
  type AuditActor,
  type AuditEventData,
  type AuditEventType,
  type AuditPayload,
  type ChainVerification,
  type StoredAuditEvent,
  type VerifyOptions,
} from '../domain/audit-chain.js';

type Tx = Prisma.TransactionClient;

/** Chave fixa do advisory lock que serializa as escritas na cadeia ("urna" em ASCII). */
const AUDIT_CHAIN_LOCK = 0x75726e61;

export interface AuditEntry {
  eventType: AuditEventType;
  actor: AuditActor;
  electionId: string | null;
  payload?: AuditPayload;
}

/**
 * Anexa um evento DENTRO da transação da operação auditada: o evento existe se e somente se
 * a operação foi confirmada.
 *
 * `pg_advisory_xact_lock` serializa as escritas até o COMMIT, então a cadeia nunca bifurca.
 * Regra para evitar deadlock: este deve ser SEMPRE o último lock que a transação adquire
 * (chame no fim da operação, depois de tocar nas outras tabelas).
 */
export async function appendAuditEvent(tx: Tx, entry: AuditEntry, now: Date): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK}::bigint)`;

  const last = await tx.auditEvent.findFirst({
    orderBy: { seq: 'desc' },
    select: { seq: true, eventHash: true },
  });
  const previousHash = last ? Buffer.from(last.eventHash) : GENESIS_HASH;
  const data: AuditEventData = {
    seq: (last?.seq ?? 0) + 1,
    eventType: entry.eventType,
    actorType: entry.actor.type,
    actorIdentifier: entry.actor.id,
    electionId: entry.electionId,
    payload: entry.payload ?? {},
    createdAt: now,
  };

  await tx.auditEvent.create({
    data: { ...data, previousHash, eventHash: computeEventHash(data, previousHash) },
  });
}

/** O CHECK do banco garante objeto; o Zod garante o tipo sem `as`. */
const payloadSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

const PAGE_SIZE = 1000;

export function createAuditReader({ prisma }: { prisma: PrismaClient }) {
  function toStored(
    row: Awaited<ReturnType<typeof prisma.auditEvent.findMany>>[number],
  ): StoredAuditEvent {
    return { ...row, payload: payloadSchema.parse(row.payload) };
  }

  async function list(params: { electionId?: string; afterSeq: number; limit: number }) {
    const rows = await prisma.auditEvent.findMany({
      where: {
        seq: { gt: params.afterSeq },
        ...(params.electionId && { electionId: params.electionId }),
      },
      orderBy: { seq: 'asc' },
      take: params.limit,
    });
    return rows.map(toStored);
  }

  /** Percorre a cadeia inteira em páginas, sem carregá-la toda na memória. */
  async function verify(options: VerifyOptions = {}): Promise<ChainVerification> {
    const verifier = createChainVerifier(options);
    let afterSeq = 0;
    for (;;) {
      const page = await prisma.auditEvent.findMany({
        where: { seq: { gt: afterSeq } },
        orderBy: { seq: 'asc' },
        take: PAGE_SIZE,
      });
      for (const row of page) verifier.push(toStored(row));
      const last = page.at(-1);
      if (!last || page.length < PAGE_SIZE) return verifier.result();
      afterSeq = last.seq;
    }
  }

  return { list, verify };
}

export type AuditReader = ReturnType<typeof createAuditReader>;
