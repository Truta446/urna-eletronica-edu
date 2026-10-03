import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../../../database/client.js';
import type { Signer } from '../../../security/signing.js';
import { generateToken, hashToken } from '../../../security/tokens.js';
import type { VoterIdentifierHasher } from '../../../security/voter-identifier.js';
import type { Clock } from '../../../shared/clock.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/app-error.js';
import { appendAuditEvent } from '../../audit/application/audit-log.js';
import type { AuditActor } from '../../audit/domain/audit-chain.js';
import { authorizationStatement } from '../../tally/domain/statements.js';

export interface AuthorizationServiceDeps {
  prisma: PrismaClient;
  clock: Clock;
  hashVoterIdentifier: VoterIdentifierHasher;
  sessionTtlSeconds: number;
  signer: Signer;
}

export interface IssuedVotingToken {
  /** Exibido UMA vez. Só o SHA-256 dele é armazenado. */
  token: string;
  expiresAt: Date;
}

const MINUTE_MS = 60_000;

function ceilToMinute(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

export function createAuthorizationService(deps: AuthorizationServiceDeps) {
  const { prisma, clock, hashVoterIdentifier, sessionTtlSeconds, signer } = deps;

  /**
   * Habilita o eleitor numa ÚNICA instrução SQL:
   *  1. confere eleição OPEN e dentro da janela;
   *  2. marca has_voted = true só se ainda for false (o lock da linha serializa chamadas concorrentes);
   *  3. cria a sessão SEM voter_id, só se o passo 2 afetou uma linha.
   * Se qualquer parte falhar, nada é gravado. A constraint trigger `authorization_balance_check`
   * confere no COMMIT que sessões e eleitores habilitados continuam em número igual.
   */
  async function authorize(
    electionId: string,
    normalizedIdentifier: string,
    actor: AuditActor,
  ): Promise<IssuedVotingToken> {
    const now = clock.now();
    const token = generateToken();
    const tokenHash = hashToken(token);
    const identifierHmac = hashVoterIdentifier(electionId, normalizedIdentifier);
    // Arredondado PARA CIMA até o minuto cheio (Fase 10, ataque A2): com o instante exato,
    // expires_at - TTL == horário do evento VOTER_AUTHORIZED, e um JOIN exato ligava os dois.
    const requestedExpiry = ceilToMinute(new Date(now.getTime() + sessionTtlSeconds * 1000));

    const issued = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ expires_at: Date }[]>`
      WITH election AS (
        SELECT id, ends_at FROM elections
         WHERE id = ${electionId}::uuid
           AND status = 'OPEN'
           AND starts_at <= ${now}::timestamptz
           AND ends_at > ${now}::timestamptz
      ), voter AS (
        UPDATE voters v SET has_voted = true
          FROM election e
         WHERE v.election_id = e.id
           AND v.identifier_hmac = ${identifierHmac}
           AND NOT v.has_voted
        RETURNING v.election_id, e.ends_at
      )
      INSERT INTO voting_sessions (election_id, token_hash, expires_at)
      SELECT election_id, ${tokenHash}, LEAST(${requestedExpiry}::timestamptz, ends_at)
        FROM voter
      RETURNING expires_at`;
      if (!row) return undefined;

      // SEM voterId de propósito: o horário deste evento é o mesmo instante usado em
      // expires_at da sessão. Com o eleitor aqui, um dump lógico ligaria eleitor e sessão.
      const nonce = randomBytes(16).toString('hex');
      const statement = authorizationStatement({ electionId, nonce, issuedAt: now.toISOString() });
      await appendAuditEvent(
        tx,
        {
          eventType: 'VOTER_AUTHORIZED',
          actor,
          electionId,
          payload: { nonce, signature: signer.sign(statement), keyId: signer.keyId },
        },
        now,
      );
      return row;
    });

    if (issued) return { token, expiresAt: issued.expires_at };
    throw await explainRefusal(electionId, identifierHmac, now);
  }

  /** Só roda quando nada foi gravado; serve para devolver um erro útil ao mesário. */
  async function explainRefusal(
    electionId: string,
    identifierHmac: Buffer<ArrayBuffer>,
    now: Date,
  ) {
    const election = await prisma.election.findUnique({
      where: { id: electionId },
      select: { status: true, startsAt: true, endsAt: true },
    });
    if (!election) return new NotFoundError('Election');
    if (election.status !== 'OPEN') return new ConflictError(`Election is ${election.status}`);
    if (now < election.startsAt) return new ConflictError('Voting has not started yet');
    if (now >= election.endsAt) return new ConflictError('Voting has already ended');

    const voter = await prisma.voter.findUnique({
      where: { electionId_identifierHmac: { electionId, identifierHmac } },
      select: { hasVoted: true },
    });
    if (!voter) return new NotFoundError('Voter');
    if (voter.hasVoted) return new ConflictError('Voter has already been authorized');
    return new ConflictError('Authorization could not be completed, retry');
  }

  return { authorize };
}

export type AuthorizationService = ReturnType<typeof createAuthorizationService>;
