import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../../database/client.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import {
  ballotCommitment,
  idempotencyScopeKey,
  nullifierFor,
  requestFingerprint,
} from '../../../security/ballot-crypto.js';
import { constantTimeEqual, hashToken } from '../../../security/tokens.js';
import type { Clock } from '../../../shared/clock.js';
import {
  BusinessRuleError,
  ConflictError,
  UnauthorizedError,
} from '../../../shared/errors/app-error.js';
import { BALLOT_ACCEPTED, ballotKindOf, canonicalRequest, type Choice } from '../domain/ballot.js';

export interface CastBallotInput {
  token: string;
  idempotencyKey: string;
  electionId: string;
  choice: Choice;
}

export interface CastBallotResult {
  status: number;
  body: Prisma.JsonValue;
  /** true quando é a resposta guardada de uma requisição anterior com a mesma Idempotency-Key. */
  replayed: boolean;
}

/** Sinal interno: o UPDATE condicional não consumiu nenhuma sessão. */
class TokenNotConsumed extends Error {}

type Tx = Prisma.TransactionClient;

interface RequestKeys {
  tokenHash: Buffer<ArrayBuffer>;
  scopeKey: Buffer<ArrayBuffer>;
  fingerprint: Buffer<ArrayBuffer>;
}

export function createBallotService({ prisma, clock }: { prisma: PrismaClient; clock: Clock }) {
  async function replayIfKnown(db: Tx | PrismaClient, keys: RequestKeys) {
    const record = await db.idempotencyRecord.findUnique({ where: { scopeKey: keys.scopeKey } });
    if (!record) return undefined;
    if (!constantTimeEqual(Buffer.from(record.requestFingerprint), keys.fingerprint)) {
      throw new BusinessRuleError('Idempotency-Key was already used with a different request');
    }
    return { status: record.responseStatus, body: record.responseBody, replayed: true };
  }

  async function resolveCandidateId(tx: Tx, electionId: string, choice: Choice) {
    if (choice.type !== 'candidate') return null;
    const candidate = await tx.candidate.findUnique({
      where: { electionId_number: { electionId, number: choice.number } },
      select: { id: true },
    });
    if (!candidate) throw new BusinessRuleError(`Candidate ${choice.number} does not exist`);
    return candidate.id;
  }

  /**
   * Tudo numa transação READ COMMITTED. Qualquer erro depois do consumo faz ROLLBACK e o token
   * volta a valer: um candidato inválido não queima o voto do eleitor.
   *
   * Concorrência: duas requisições com o mesmo token disputam o lock da linha da sessão no
   * UPDATE. A segunda espera, reavalia `NOT consumed` depois do COMMIT da primeira e não
   * consome nada. Se for um retry (mesma Idempotency-Key), recebe a resposta original.
   */
  async function castInTransaction(input: CastBallotInput, keys: RequestKeys, now: Date) {
    return prisma.$transaction(async (tx): Promise<CastBallotResult> => {
      const replay = await replayIfKnown(tx, keys);
      if (replay) return replay;

      const [session] = await tx.$queryRaw<{ election_id: string }[]>`
        UPDATE voting_sessions
           SET consumed = true
         WHERE token_hash = ${keys.tokenHash}
           AND NOT consumed
           AND expires_at > ${now}::timestamptz
        RETURNING election_id`;
      if (!session) throw new TokenNotConsumed();
      if (session.election_id !== input.electionId) {
        throw new BusinessRuleError('Voting token does not belong to this election');
      }

      const candidateId = await resolveCandidateId(tx, input.electionId, input.choice);
      const ballotId = randomUUID();
      const kind = ballotKindOf(input.choice);

      await tx.ballot.create({
        data: {
          id: ballotId,
          electionId: input.electionId,
          kind,
          candidateId,
          nullifier: nullifierFor(input.token),
          commitment: ballotCommitment({
            ballotId,
            electionId: input.electionId,
            kind,
            candidateId,
          }),
        },
        select: { id: true },
      });
      await tx.idempotencyRecord.create({
        data: {
          scopeKey: keys.scopeKey,
          electionId: input.electionId,
          requestFingerprint: keys.fingerprint,
          responseStatus: 201,
          responseBody: BALLOT_ACCEPTED,
        },
      });
      return { status: 201, body: BALLOT_ACCEPTED, replayed: false };
    });
  }

  /** Fora da transação: só explica por que o token não pôde ser usado. */
  async function explainUnusableToken(keys: RequestKeys, now: Date): Promise<CastBallotResult> {
    // Um retry concorrente pode ter acabado de gravar a resposta original.
    const replay = await replayIfKnown(prisma, keys);
    if (replay) return replay;

    const session = await prisma.votingSession.findUnique({
      where: { tokenHash: keys.tokenHash },
      select: { consumed: true, expiresAt: true },
    });
    if (session?.consumed) throw new ConflictError('Voting token has already been used');
    if (!session || session.expiresAt <= now) {
      throw new UnauthorizedError('Invalid or expired voting token');
    }
    throw new ConflictError('Ballot could not be cast, retry');
  }

  async function cast(input: CastBallotInput): Promise<CastBallotResult> {
    const now = clock.now();
    const keys: RequestKeys = {
      tokenHash: hashToken(input.token),
      scopeKey: idempotencyScopeKey(input.token, input.idempotencyKey),
      fingerprint: requestFingerprint(
        input.token,
        canonicalRequest(input.electionId, input.choice),
      ),
    };

    try {
      return await castInTransaction(input, keys, now);
    } catch (error) {
      if (error instanceof TokenNotConsumed) return explainUnusableToken(keys, now);
      throw error;
    }
  }

  return { cast };
}

export type BallotService = ReturnType<typeof createBallotService>;
