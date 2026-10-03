import type { PrismaClient } from '../../../database/client.js';
import { isUniqueViolation } from '../../../database/errors.js';
import type { VoterIdentifierHasher } from '../../../security/voter-identifier.js';
import type { Clock } from '../../../shared/clock.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/app-error.js';
import { appendAuditEvent } from '../../audit/application/audit-log.js';
import type { AuditActor } from '../../audit/domain/audit-chain.js';

export interface RegisteredVoter {
  id: string;
  electionId: string;
}

export interface VoterServiceDeps {
  prisma: PrismaClient;
  clock: Clock;
  hashVoterIdentifier: VoterIdentifierHasher;
}

export function createVoterService({ prisma, clock, hashVoterIdentifier }: VoterServiceDeps) {
  /**
   * Recebe o identificador JÁ normalizado e o descarta depois do HMAC: ele não é
   * armazenado, logado nem devolvido.
   */
  async function register(
    electionId: string,
    normalizedIdentifier: string,
    actor: AuditActor,
  ): Promise<RegisteredVoter> {
    const election = await prisma.election.findUnique({
      where: { id: electionId },
      select: { status: true },
    });
    if (!election) throw new NotFoundError('Election');
    if (election.status !== 'DRAFT') {
      throw new ConflictError(
        `Election is ${election.status}, voters can only be registered in DRAFT`,
      );
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const voter = await tx.voter.create({
          data: {
            electionId,
            identifierHmac: hashVoterIdentifier(electionId, normalizedIdentifier),
          },
          select: { id: true, electionId: true },
        });
        // Só o id interno: nem o CPF nem o HMAC dele entram no log de auditoria.
        await appendAuditEvent(
          tx,
          { eventType: 'VOTER_REGISTERED', actor, electionId, payload: { voterId: voter.id } },
          clock.now(),
        );
        return voter;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'voters_election_id_identifier_hmac_key')) {
        throw new ConflictError('Voter already registered in this election');
      }
      throw error;
    }
  }

  return { register };
}

export type VoterService = ReturnType<typeof createVoterService>;
