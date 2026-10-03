import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { merkleRoot, sortLeaves } from '../security/merkle.js';
import { keyIdOf, verifySignature } from '../security/signing.js';
import { createPublicKey } from 'node:crypto';
import {
  recomputeCommitment,
  type StoredBallot,
} from '../modules/tally/application/ballot-codec.js';
import {
  tallyResultSchema,
  type BallotDecoder,
} from '../modules/tally/application/tally.service.js';
import { resultHash, resultStatement, sealStatement } from '../modules/tally/domain/statements.js';
import { tallyBallots } from '../modules/tally/domain/tally.js';
import { decodePlainBallot } from '../modules/tally/application/ballot-codec.js';

/**
 * Verificador INDEPENDENTE: usa apenas o que é público (GET /elections/:id/tally e /ballots).
 * Não lê banco, não confia no servidor. Refaz: assinaturas, commitments, Merkle root e a contagem.
 *
 * Observação honesta: ele reaproveita as funções puras do próprio projeto. Uma verificação
 * realmente independente seria reimplementada por terceiros a partir da especificação (docs/).
 */
export const publishedTallySchema = z.object({
  electionId: z.string(),
  result: tallyResultSchema,
  merkleRoot: z.string(),
  resultHash: z.string(),
  signature: z.string(),
  keyId: z.string(),
  publicKey: z.string(),
  seal: z.object({
    electionId: z.string(),
    ballots: z.number().int(),
    merkleRoot: z.string(),
    auditHeadSeq: z.number().int(),
    auditHeadHash: z.string(),
    sealedAt: z.string(),
    signature: z.string(),
    keyId: z.string(),
  }),
  decryptionKey: z.string().optional(),
});

export const publishedBallotsSchema = z.object({
  ballots: z.array(
    z.object({
      id: z.string(),
      commitment: z.string(),
      kind: z.enum(['CANDIDATE', 'BLANK', 'NULL_VOTE']).nullable(),
      candidateId: z.string().nullable(),
      encapsulatedKey: z.string().nullable().optional(),
      ciphertext: z.string().nullable().optional(),
    }),
  ),
});

export type PublishedTally = z.infer<typeof publishedTallySchema>;
export type PublishedBallots = z.infer<typeof publishedBallotsSchema>;

export interface VerificationReport {
  valid: boolean;
  checks: { check: string; ok: boolean }[];
}

/** Converte a forma publicada para a forma usada pelas funções puras. */
export function toStoredBallot(
  electionId: string,
  b: PublishedBallots['ballots'][number],
): StoredBallot {
  return {
    id: b.id,
    electionId,
    kind: b.kind,
    candidateId: b.candidateId,
    commitment: Buffer.from(b.commitment, 'hex'),
    encapsulatedKey: b.encapsulatedKey ? Buffer.from(b.encapsulatedKey, 'base64url') : null,
    ciphertext: b.ciphertext ? Buffer.from(b.ciphertext, 'base64url') : null,
  };
}

export const plainPublishedDecoder: BallotDecoder = (ballots) =>
  Promise.resolve(ballots.map(decodePlainBallot));

export async function verifyPublishedResult(
  tally: PublishedTally,
  published: PublishedBallots,
  decode: BallotDecoder = plainPublishedDecoder,
): Promise<VerificationReport> {
  const checks: VerificationReport['checks'] = [];
  const record = (check: string, ok: boolean) => checks.push({ check, ok });

  const keyId = keyIdOf(
    createPublicKey({
      key: Buffer.from(tally.publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    }),
  );
  record('keyId corresponde à chave pública', keyId === tally.keyId && keyId === tally.seal.keyId);

  const sealSignature = tally.seal.signature;
  const sealData = {
    electionId: tally.seal.electionId,
    ballots: tally.seal.ballots,
    merkleRoot: tally.seal.merkleRoot,
    auditHeadSeq: tally.seal.auditHeadSeq,
    auditHeadHash: tally.seal.auditHeadHash,
    sealedAt: tally.seal.sealedAt,
  };
  record(
    'assinatura do lacre',
    verifySignature(tally.publicKey, sealStatement(sealData), sealSignature),
  );
  record('lacre é desta eleição', tally.seal.electionId === tally.electionId);

  const ballots = published.ballots.map((b) => toStoredBallot(tally.electionId, b));
  record(
    'cada commitment recalculado a partir do voto publicado',
    ballots.every((b) => recomputeCommitment(b).equals(b.commitment)),
  );
  const root = merkleRoot(sortLeaves(ballots.map((b) => b.commitment))).toString('hex');
  record('Merkle root dos votos == root do lacre', root === tally.seal.merkleRoot);
  record('Merkle root do resultado == root do lacre', tally.merkleRoot === tally.seal.merkleRoot);
  record('nº de votos publicados == nº lacrado', ballots.length === tally.seal.ballots);

  let recount: unknown;
  try {
    const candidates = tally.result.candidates.map((c) => ({
      id: c.candidateId,
      number: c.number,
      name: c.name,
    }));
    recount = tallyBallots(await decode(ballots), candidates);
  } catch {
    recount = undefined;
  }
  record(
    'recontagem independente == resultado publicado',
    isDeepStrictEqual(recount, tally.result),
  );

  const statement = resultStatement({
    electionId: tally.electionId,
    merkleRoot: tally.merkleRoot,
    result: tally.result,
    sealSignature,
  });
  record('hash do resultado', resultHash(statement).toString('hex') === tally.resultHash);
  record('assinatura do resultado', verifySignature(tally.publicKey, statement, tally.signature));

  return { valid: checks.every((c) => c.ok), checks };
}
