import type { PrismaClient } from '../../../database/client.js';
import type { Clock } from '../../../shared/clock.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from '../../../shared/errors/app-error.js';
import { isValidPublicKey } from '../../../security/ballot-encryption.js';
import type { Signer } from '../../../security/signing.js';
import { appendAuditEvent } from '../../audit/application/audit-log.js';
import { sealBallotBox } from '../../tally/application/seal.js';
import { SYSTEM_ACTOR, type AuditActor } from '../../audit/domain/audit-chain.js';
import { validateNewSchedule, type Election, type ElectionStatus } from '../domain/election.js';

export interface ElectionServiceDeps {
  prisma: PrismaClient;
  clock: Clock;
  signer: Signer;
}

export interface CreateElectionInput {
  name: string;
  startsAt: Date;
  endsAt: Date;
  /** v2: se presente, todos os votos desta eleição serão cifrados para esta chave. */
  encryptionPublicKey?: Buffer<ArrayBuffer>;
}

const electionSelect = {
  id: true,
  name: true,
  status: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  encryptionPublicKey: true,
} as const;

export function createElectionService({ prisma, clock, signer }: ElectionServiceDeps) {
  async function get(id: string): Promise<Election> {
    const election = await prisma.election.findUnique({ where: { id }, select: electionSelect });
    if (!election) throw new NotFoundError('Election');
    return election;
  }

  function wrongStatus(actual: ElectionStatus, expected: ElectionStatus): ConflictError {
    return new ConflictError(`Election is ${actual}, expected ${expected}`);
  }

  async function create(input: CreateElectionInput, actor: AuditActor): Promise<Election> {
    const now = clock.now();
    validateNewSchedule(input, now);
    if (input.encryptionPublicKey && !(await isValidPublicKey(input.encryptionPublicKey))) {
      throw new BusinessRuleError('encryptionPublicKey is not a valid X25519 public key');
    }
    return prisma.$transaction(async (tx) => {
      const election = await tx.election.create({ data: input, select: electionSelect });
      await appendAuditEvent(
        tx,
        {
          eventType: 'ELECTION_CREATED',
          actor,
          electionId: election.id,
          payload: {
            name: election.name,
            startsAt: election.startsAt.toISOString(),
            endsAt: election.endsAt.toISOString(),
            encryptionPublicKey: election.encryptionPublicKey
              ? Buffer.from(election.encryptionPublicKey).toString('hex')
              : null,
          },
        },
        now,
      );
      return election;
    });
  }

  /**
   * A transição é um único UPDATE condicional: verificar e alterar acontecem atomicamente
   * no banco. Se nada for alterado, uma leitura posterior só serve para explicar o motivo.
   */
  async function open(id: string, actor: AuditActor): Promise<Election> {
    const now = clock.now();
    const opened = await prisma.$transaction(async (tx) => {
      const [updated] = await tx.election.updateManyAndReturn({
        where: {
          id,
          status: 'DRAFT',
          endsAt: { gt: now },
          candidates: { some: {} },
          voters: { some: {} },
        },
        data: { status: 'OPEN' },
        select: electionSelect,
      });
      if (updated) {
        await appendAuditEvent(tx, { eventType: 'ELECTION_OPENED', actor, electionId: id }, now);
      }
      return updated;
    });
    if (opened) return opened;

    const current = await get(id);
    if (current.status !== 'DRAFT') throw wrongStatus(current.status, 'DRAFT');
    if (current.endsAt <= now) throw new BusinessRuleError('Election window has already ended');
    throw new BusinessRuleError('Election needs at least one candidate and one voter to open');
  }

  /**
   * Só depois de endsAt: um administrador não pode encerrar a votação antes da hora.
   * Na mesma transação:
   *  - apaga os registros de idempotência (depois do fechamento não há retry possível);
   *  - lacra a urna: BALLOT_BOX_SEALED registra as contagens finais. O UPDATE da eleição espera
   *    as transações de voto em andamento (elas seguram FOR SHARE na linha da eleição), e
   *    depois dele nenhum voto entra. As contagens são, portanto, definitivas.
   *    O lacre inclui a Merkle root dos votos e o checkpoint da auditoria, assinados (Ed25519).
   */
  async function close(id: string, actor: AuditActor): Promise<Election> {
    const now = clock.now();
    const closed = await prisma.$transaction(async (tx) => {
      const [updated] = await tx.election.updateManyAndReturn({
        where: { id, status: 'OPEN', endsAt: { lte: now } },
        data: { status: 'CLOSED' },
        select: electionSelect,
      });
      if (!updated) return undefined;

      const purged = await tx.idempotencyRecord.deleteMany({ where: { electionId: id } });
      const [ballots, consumedSessions, authorizedVoters, registeredVoters] = await Promise.all([
        tx.ballot.count({ where: { electionId: id } }),
        tx.votingSession.count({ where: { electionId: id, consumed: true } }),
        tx.voter.count({ where: { electionId: id, hasVoted: true } }),
        tx.voter.count({ where: { electionId: id } }),
      ]);

      const auditHead = await appendAuditEvent(
        tx,
        { eventType: 'ELECTION_CLOSED', actor, electionId: id },
        now,
      );
      const seal = await sealBallotBox(tx, { electionId: id, signer, now, auditHead });
      await appendAuditEvent(
        tx,
        {
          eventType: 'BALLOT_BOX_SEALED',
          actor: SYSTEM_ACTOR,
          electionId: id,
          payload: {
            ballots,
            consumedSessions,
            authorizedVoters,
            registeredVoters,
            authorizedWithoutBallot: authorizedVoters - ballots,
            idempotencyRecordsPurged: purged.count,
            merkleRoot: seal.merkleRoot,
            auditHeadSeq: seal.auditHeadSeq,
            auditHeadHash: seal.auditHeadHash,
            sealedAt: seal.sealedAt,
            signature: seal.signature,
            keyId: seal.keyId,
          },
        },
        now,
      );
      return updated;
    });
    if (closed) return closed;

    const current = await get(id);
    if (current.status !== 'OPEN') throw wrongStatus(current.status, 'OPEN');
    throw new BusinessRuleError('Election can only be closed after endsAt');
  }

  /** Mais recentes primeiro. Dados públicos (os mesmos de GET /elections/:id). */
  async function list(): Promise<Election[]> {
    return prisma.election.findMany({
      select: electionSelect,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  return { create, get, list, open, close };
}

export type ElectionService = ReturnType<typeof createElectionService>;
