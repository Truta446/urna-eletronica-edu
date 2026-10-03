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
  type AuditFormat,
  type AuditPayload,
  type ChainFailureReason,
  type ChainVerification,
  type StoredAuditEvent,
  type VerifyOptions,
} from '../domain/audit-chain.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

export const GLOBAL_CHAIN = 'global';

export interface AuditEntry {
  eventType: AuditEventType;
  actor: AuditActor;
  electionId: string | null;
  payload?: AuditPayload;
}

/**
 * Em qual cadeia os eventos de uma eleição vão:
 * - eleição que já tem eventos na cadeia global (criada antes da migração): continua nela (formato 1);
 * - qualquer outra: a cadeia da própria eleição (formato 2).
 */
export async function chainFor(
  db: Db,
  electionId: string | null,
): Promise<{ key: string; format: AuditFormat }> {
  if (!electionId) return { key: GLOBAL_CHAIN, format: 1 };
  const legacy = await db.auditEvent.findFirst({
    where: { chainKey: GLOBAL_CHAIN, electionId },
    select: { id: true },
  });
  return legacy ? { key: GLOBAL_CHAIN, format: 1 } : { key: electionId, format: 2 };
}

/**
 * Anexa um evento DENTRO da transação da operação auditada: o evento existe se e somente se
 * a operação foi confirmada.
 *
 * O advisory lock é POR CADEIA (hash da chave da cadeia): eventos da mesma eleição são
 * serializados, e eleições diferentes não esperam umas pelas outras. Com uma cadeia global, a
 * vazão do sistema inteiro ficava presa em ~320 habilitações/s (docs/performance.md).
 * Regra para evitar deadlock: este é SEMPRE o último lock que a transação adquire.
 */
export async function appendAuditEvent(
  tx: Tx,
  entry: AuditEntry,
  now: Date,
): Promise<{ seq: number; hash: string; chainKey: string }> {
  const chain = await chainFor(tx, entry.electionId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chain.key}, 0))`;

  const last = await tx.auditEvent.findFirst({
    where: { chainKey: chain.key },
    orderBy: { seq: 'desc' },
    select: { seq: true, eventHash: true },
  });
  const previousHash = last ? Buffer.from(last.eventHash) : GENESIS_HASH;
  const data: AuditEventData = {
    format: chain.format,
    chainKey: chain.key,
    seq: (last?.seq ?? 0) + 1,
    eventType: entry.eventType,
    actorType: entry.actor.type,
    actorIdentifier: entry.actor.id,
    electionId: entry.electionId,
    payload: entry.payload ?? {},
    createdAt: now,
  };

  const eventHash = computeEventHash(data, previousHash);
  await tx.auditEvent.create({ data: { ...data, previousHash, eventHash } });
  return { seq: data.seq, hash: eventHash.toString('hex'), chainKey: chain.key };
}

/** O CHECK do banco garante objeto; o Zod garante o tipo sem `as`. */
const payloadSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
const formatSchema = z.union([z.literal(1), z.literal(2)]);

const PAGE_SIZE = 1000;

export interface ListedAuditEvent extends StoredAuditEvent {
  id: number;
}

export type AllChainsVerification =
  | { valid: true; eventCount: number; chains: number }
  | {
      valid: false;
      eventCount: number;
      chains: number;
      failure: { chain: string; seq: number; reason: ChainFailureReason };
    };

export function createAuditReader({ prisma }: { prisma: PrismaClient }) {
  function toStored(
    row: Awaited<ReturnType<typeof prisma.auditEvent.findMany>>[number],
  ): ListedAuditEvent {
    return {
      ...row,
      format: formatSchema.parse(row.format),
      payload: payloadSchema.parse(row.payload),
    };
  }

  async function list(params: { electionId?: string; afterId: number; limit: number }) {
    const rows = await prisma.auditEvent.findMany({
      where: {
        id: { gt: params.afterId },
        ...(params.electionId && { electionId: params.electionId }),
      },
      orderBy: { id: 'asc' },
      take: params.limit,
    });
    return rows.map(toStored);
  }

  /** Verifica UMA cadeia, em páginas, sem carregá-la toda na memória. */
  async function verifyChain(
    chainKey: string,
    options: VerifyOptions = {},
  ): Promise<ChainVerification> {
    const verifier = createChainVerifier(options);
    let afterSeq = 0;
    for (;;) {
      const page = await prisma.auditEvent.findMany({
        where: { chainKey, seq: { gt: afterSeq } },
        orderBy: { seq: 'asc' },
        take: PAGE_SIZE,
      });
      for (const row of page) {
        const event = toStored(row);
        // Uma cadeia de eleição começa, obrigatoriamente, pela criação da própria eleição.
        if (
          chainKey !== GLOBAL_CHAIN &&
          event.seq === 1 &&
          event.eventType !== 'ELECTION_CREATED'
        ) {
          return {
            valid: false,
            eventCount: 0,
            failure: { seq: 1, reason: 'CHAIN_HEAD_MISMATCH' },
          };
        }
        if (event.chainKey !== chainKey) {
          return {
            valid: false,
            eventCount: 0,
            failure: { seq: event.seq, reason: 'WRONG_CHAIN' },
          };
        }
        verifier.push(event);
      }
      const last = page.at(-1);
      if (!last || page.length < PAGE_SIZE) return verifier.result();
      afterSeq = last.seq;
    }
  }

  /**
   * Todas as cadeias, e também a completude: toda eleição existente precisa ter o próprio
   * ELECTION_CREATED. Sem isso, apagar a cadeia INTEIRA de uma eleição passaria despercebido.
   */
  async function verifyAll(): Promise<AllChainsVerification> {
    const chains = await prisma.auditEvent.groupBy({
      by: ['chainKey'],
      orderBy: { chainKey: 'asc' },
    });
    let eventCount = 0;
    for (const { chainKey } of chains) {
      const result = await verifyChain(chainKey);
      eventCount += result.eventCount;
      if (!result.valid) {
        return {
          valid: false,
          eventCount,
          chains: chains.length,
          failure: { chain: chainKey, ...result.failure },
        };
      }
    }
    const orphan = await prisma.$queryRaw<{ id: string }[]>`
      SELECT e.id FROM elections e
       WHERE NOT e.created_before_audit
         AND NOT EXISTS (SELECT 1 FROM audit_events a
                          WHERE a.election_id = e.id AND a.event_type = 'ELECTION_CREATED')
       LIMIT 1`;
    if (orphan[0]) {
      return {
        valid: false,
        eventCount,
        chains: chains.length,
        failure: { chain: orphan[0].id, seq: 1, reason: 'ELECTION_WITHOUT_AUDIT' },
      };
    }
    return { valid: true, eventCount, chains: chains.length };
  }

  return {
    list,
    verifyChain,
    verifyAll,
    chainKeyFor: async (electionId: string) => (await chainFor(prisma, electionId)).key,
  };
}

export type AuditReader = ReturnType<typeof createAuditReader>;
