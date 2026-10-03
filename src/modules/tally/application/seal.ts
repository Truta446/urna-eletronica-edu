import type { Prisma } from '../../../generated/prisma/client.js';
import { merkleRoot, sortLeaves } from '../../../security/merkle.js';
import type { Signer } from '../../../security/signing.js';
import { sealStatement, type SealData } from '../domain/statements.js';

export interface Seal extends SealData {
  signature: string;
  keyId: string;
}

/**
 * Lacre da urna, dentro da transação do fechamento: Merkle root (RFC 6962) dos commitments em
 * ordem canônica + checkpoint da cadeia de auditoria, assinados com Ed25519.
 * A partir daqui, qualquer voto alterado, removido ou inserido muda a root e é detectado.
 */
export async function sealBallotBox(
  tx: Prisma.TransactionClient,
  params: {
    electionId: string;
    signer: Signer;
    now: Date;
    auditHead: { seq: number; hash: string };
  },
): Promise<Seal> {
  const rows = await tx.ballot.findMany({
    where: { electionId: params.electionId },
    select: { commitment: true },
  });
  const seal: SealData = {
    electionId: params.electionId,
    ballots: rows.length,
    merkleRoot: merkleRoot(sortLeaves(rows.map((r) => r.commitment))).toString('hex'),
    auditHeadSeq: params.auditHead.seq,
    auditHeadHash: params.auditHead.hash,
    sealedAt: params.now.toISOString(),
  };
  return {
    ...seal,
    signature: params.signer.sign(sealStatement(seal)),
    keyId: params.signer.keyId,
  };
}
