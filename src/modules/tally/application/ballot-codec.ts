import { ballotCommitment, encryptedBallotCommitment } from '../../../security/ballot-crypto.js';
import type { DecodedChoice } from '../domain/tally.js';

/** Voto como está gravado (ou publicado). */
export interface StoredBallot {
  id: string;
  electionId: string;
  kind: 'CANDIDATE' | 'BLANK' | 'NULL_VOTE' | null;
  candidateId: string | null;
  commitment: Uint8Array;
  /** Só em votos cifrados (Fase 8). */
  encapsulatedKey?: Uint8Array | null;
  ciphertext?: Uint8Array | null;
}

export class UndecodableBallotError extends Error {}

/** Recalcula o commitment a partir dos dados da linha: qualquer edição na linha muda o valor. */
export function recomputeCommitment(ballot: StoredBallot): Buffer<ArrayBuffer> {
  if (ballot.ciphertext && ballot.encapsulatedKey) {
    return encryptedBallotCommitment({
      ballotId: ballot.id,
      electionId: ballot.electionId,
      encapsulatedKey: ballot.encapsulatedKey,
      ciphertext: ballot.ciphertext,
    });
  }
  return ballotCommitment({
    ballotId: ballot.id,
    electionId: ballot.electionId,
    kind: ballot.kind ?? '',
    candidateId: ballot.candidateId,
  });
}

export function decodePlainBallot(ballot: StoredBallot): DecodedChoice {
  switch (ballot.kind) {
    case 'CANDIDATE':
      if (!ballot.candidateId) throw new UndecodableBallotError(ballot.id);
      return { kind: 'CANDIDATE', candidateId: ballot.candidateId };
    case 'BLANK':
      return { kind: 'BLANK' };
    case 'NULL_VOTE':
      return { kind: 'NULL_VOTE' };
    case null:
      throw new UndecodableBallotError(ballot.id);
  }
}
