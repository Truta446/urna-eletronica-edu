import { decryptChoice, DecryptionError } from '../../../security/ballot-encryption.js';
import type { DecodedChoice } from '../domain/tally.js';
import { decodePlainBallot, UndecodableBallotError, type StoredBallot } from './ballot-codec.js';
import type { BallotDecoder } from './tally.service.js';

/**
 * Decodificador com a chave privada da eleição (reconstruída pelos trustees, ou publicada após
 * a apuração). Falha do AEAD = voto adulterado, copiado de outro voto/eleição, ou chave errada.
 */
export function createTrusteeDecoder(privateKey: Uint8Array): BallotDecoder {
  async function decode(ballot: StoredBallot): Promise<DecodedChoice> {
    if (!ballot.ciphertext || !ballot.encapsulatedKey) return decodePlainBallot(ballot);
    try {
      return await decryptChoice(
        privateKey,
        { electionId: ballot.electionId, ballotId: ballot.id },
        { encapsulatedKey: ballot.encapsulatedKey, ciphertext: ballot.ciphertext },
      );
    } catch (error) {
      if (error instanceof DecryptionError) throw new UndecodableBallotError(ballot.id);
      throw error;
    }
  }
  return (ballots) => Promise.all(ballots.map(decode));
}
