import { z } from 'zod';
import type { PrismaClient } from '../../../database/client.js';
import { keyPairMatches } from '../../../security/ballot-encryption.js';
import { merkleRoot } from '../../../security/merkle.js';
import { combineShares } from '../../../security/trustees.js';
import { verifySignature, type Signer } from '../../../security/signing.js';
import type { Clock } from '../../../shared/clock.js';
import {
  BusinessRuleError,
  ConflictError,
  IntegrityError,
  NotFoundError,
} from '../../../shared/errors/app-error.js';
import { appendAuditEvent, createAuditReader } from '../../audit/application/audit-log.js';
import type { AuditActor } from '../../audit/domain/audit-chain.js';
import { resultHash, resultStatement, sealStatement, type SealData } from '../domain/statements.js';
import {
  tallyBallots,
  UnknownCandidateError,
  type DecodedChoice,
  type TallyResultData,
} from '../domain/tally.js';
import {
  decodePlainBallot,
  recomputeCommitment,
  UndecodableBallotError,
  type StoredBallot,
} from './ballot-codec.js';
import { createTrusteeDecoder } from './encrypted-ballots.js';

export type IntegrityFailureReason =
  | 'SEAL_MISSING'
  | 'SEAL_SIGNATURE_INVALID'
  | 'AUDIT_CHAIN_INVALID'
  | 'COMMITMENT_MISMATCH'
  | 'MERKLE_ROOT_MISMATCH'
  | 'BALLOT_COUNT_MISMATCH'
  | 'SESSION_COUNT_MISMATCH'
  | 'UNDECODABLE_BALLOT'
  | 'UNKNOWN_CANDIDATE';

class IntegrityFailure extends Error {
  constructor(readonly reason: IntegrityFailureReason) {
    super(reason);
  }
}

const sealPayloadSchema = z.object({
  ballots: z.number().int(),
  authorizedVoters: z.number().int(),
  registeredVoters: z.number().int(),
  authorizedWithoutBallot: z.number().int(),
  merkleRoot: z.string(),
  auditHeadSeq: z.number().int(),
  auditHeadHash: z.string(),
  sealedAt: z.string(),
  signature: z.string(),
  keyId: z.string(),
});

export type SealPayload = z.infer<typeof sealPayloadSchema>;

export const tallyResultSchema = z.object({
  candidates: z.array(
    z.object({
      candidateId: z.string(),
      number: z.number().int(),
      name: z.string(),
      votes: z.number().int(),
    }),
  ),
  blank: z.number().int(),
  null: z.number().int(),
  totalBallots: z.number().int(),
});

export interface TallyDeps {
  prisma: PrismaClient;
  clock: Clock;
  signer: Signer;
}

/** Decodifica votos; a Fase 8 acrescenta votos cifrados. */
export type BallotDecoder = (ballots: StoredBallot[]) => Promise<DecodedChoice[]>;

export function createTallyService({ prisma, clock, signer }: TallyDeps) {
  const auditReader = createAuditReader({ prisma });

  async function loadSeal(electionId: string): Promise<SealPayload> {
    const event = await prisma.auditEvent.findFirst({
      where: { electionId, eventType: 'BALLOT_BOX_SEALED' },
      select: { payload: true },
    });
    const parsed = sealPayloadSchema.safeParse(event?.payload);
    if (!parsed.success) throw new IntegrityFailure('SEAL_MISSING');
    return parsed.data;
  }

  function sealDataOf(electionId: string, seal: SealPayload): SealData {
    return {
      electionId,
      ballots: seal.ballots,
      merkleRoot: seal.merkleRoot,
      auditHeadSeq: seal.auditHeadSeq,
      auditHeadHash: seal.auditHeadHash,
      sealedAt: seal.sealedAt,
    };
  }

  async function loadBallots(electionId: string): Promise<StoredBallot[]> {
    return prisma.ballot.findMany({
      where: { electionId },
      select: {
        id: true,
        electionId: true,
        kind: true,
        candidateId: true,
        commitment: true,
        encapsulatedKey: true,
        ciphertext: true,
      },
      orderBy: { commitment: 'asc' },
    });
  }

  /**
   * Nenhum voto é contado antes de TODAS estas verificações passarem:
   *  1. o lacre existe e a assinatura Ed25519 confere;
   *  2. a cadeia de auditoria é íntegra até o checkpoint assinado no lacre;
   *  3. cada voto recalcula o próprio commitment (linha não foi editada);
   *  4. a Merkle root dos votos atuais é a do lacre (nenhum voto entrou ou saiu);
   *  5. votos == sessões consumidas.
   */
  async function verifyIntegrity(electionId: string) {
    const seal = await loadSeal(electionId);
    const sealData = sealDataOf(electionId, seal);
    if (
      seal.keyId !== signer.keyId ||
      !verifySignature(signer.publicKey, sealStatement(sealData), seal.signature)
    ) {
      throw new IntegrityFailure('SEAL_SIGNATURE_INVALID');
    }

    const chain = await auditReader.verify({
      anchor: { seq: seal.auditHeadSeq, hash: seal.auditHeadHash },
    });
    if (!chain.valid) throw new IntegrityFailure('AUDIT_CHAIN_INVALID');

    const ballots = await loadBallots(electionId);
    for (const ballot of ballots) {
      if (!recomputeCommitment(ballot).equals(ballot.commitment)) {
        throw new IntegrityFailure('COMMITMENT_MISMATCH');
      }
    }
    if (ballots.length !== seal.ballots) throw new IntegrityFailure('BALLOT_COUNT_MISMATCH');
    // Já ordenados por commitment pelo banco (bytea compara byte a byte).
    const root = merkleRoot(ballots.map((b) => b.commitment)).toString('hex');
    if (root !== seal.merkleRoot) throw new IntegrityFailure('MERKLE_ROOT_MISMATCH');

    const consumed = await prisma.votingSession.count({ where: { electionId, consumed: true } });
    if (consumed !== ballots.length) throw new IntegrityFailure('SESSION_COUNT_MISMATCH');

    return { seal, ballots, root };
  }

  async function count(
    electionId: string,
    ballots: StoredBallot[],
    decode: BallotDecoder,
  ): Promise<TallyResultData> {
    const candidates = await prisma.candidate.findMany({
      where: { electionId },
      select: { id: true, number: true, name: true },
    });
    try {
      return tallyBallots(await decode(ballots), candidates);
    } catch (error) {
      if (error instanceof UndecodableBallotError) throw new IntegrityFailure('UNDECODABLE_BALLOT');
      if (error instanceof UnknownCandidateError) throw new IntegrityFailure('UNKNOWN_CANDIDATE');
      throw error;
    }
  }

  async function recordFailure(electionId: string, actor: AuditActor, reason: string) {
    const now = clock.now();
    await prisma.$transaction(async (tx) => {
      await appendAuditEvent(tx, { eventType: 'TALLY_STARTED', actor, electionId }, now);
      await appendAuditEvent(
        tx,
        { eventType: 'TALLY_FAILED', actor, electionId, payload: { reason } },
        now,
      );
    });
  }

  /**
   * CLOSED -> TALLIED. As leituras acontecem fora da transação (com a eleição CLOSED, os votos
   * já não mudam pela aplicação); a gravação é um UPDATE condicional, então duas apurações
   * concorrentes resultam em exatamente uma.
   */
  /**
   * v1: nada a fazer. v2: reconstrói a chave privada a partir das partes dos trustees e confere
   * que ela corresponde à chave pública da eleição antes de abrir qualquer voto.
   */
  async function decoderFor(
    encryptionPublicKey: Uint8Array | null,
    trusteeShares?: readonly string[],
  ): Promise<{ decode: BallotDecoder; decryptionKey: Buffer<ArrayBuffer> | null }> {
    if (!encryptionPublicKey) {
      if (trusteeShares?.length)
        throw new BusinessRuleError('This election has no encrypted ballots');
      return { decode: plainDecoder, decryptionKey: null };
    }
    if (!trusteeShares || trusteeShares.length < 2) {
      throw new BusinessRuleError(
        'Encrypted election: provide at least the threshold of trustee shares',
      );
    }
    let privateKey: Buffer<ArrayBuffer>;
    try {
      privateKey = await combineShares(trusteeShares);
    } catch {
      throw new BusinessRuleError('Trustee shares are malformed');
    }
    if (!(await keyPairMatches(encryptionPublicKey, privateKey))) {
      throw new BusinessRuleError('Trustee shares do not reconstruct the election key');
    }
    return { decode: createTrusteeDecoder(privateKey), decryptionKey: privateKey };
  }

  async function tally(
    electionId: string,
    actor: AuditActor,
    options: { trusteeShares?: readonly string[] } = {},
  ) {
    const election = await prisma.election.findUnique({
      where: { id: electionId },
      select: { status: true, encryptionPublicKey: true },
    });
    if (!election) throw new NotFoundError('Election');
    if (election.status !== 'CLOSED')
      throw new ConflictError(`Election is ${election.status}, expected CLOSED`);
    const { decode, decryptionKey } = await decoderFor(
      election.encryptionPublicKey,
      options.trusteeShares,
    );

    let verified: Awaited<ReturnType<typeof verifyIntegrity>>;
    let result: TallyResultData;
    try {
      verified = await verifyIntegrity(electionId);
      result = await count(electionId, verified.ballots, decode);
    } catch (error) {
      if (!(error instanceof IntegrityFailure)) throw error;
      await recordFailure(electionId, actor, error.reason);
      throw new IntegrityError(error.reason);
    }

    const statement = resultStatement({
      electionId,
      merkleRoot: verified.root,
      result,
      sealSignature: verified.seal.signature,
    });
    const hash = resultHash(statement);
    const signature = signer.sign(statement);
    const now = clock.now();

    await prisma.$transaction(async (tx) => {
      const [updated] = await tx.election.updateManyAndReturn({
        where: { id: electionId, status: 'CLOSED' },
        data: { status: 'TALLIED' },
        select: { id: true },
      });
      if (!updated) throw new ConflictError('Election was tallied concurrently');

      await appendAuditEvent(tx, { eventType: 'TALLY_STARTED', actor, electionId }, now);
      await tx.tallyResult.create({
        data: {
          electionId,
          result: { ...result },
          merkleRoot: Buffer.from(verified.root, 'hex'),
          resultHash: hash,
          signature,
          keyId: signer.keyId,
          decryptionKey,
          createdAt: now,
        },
      });
      await appendAuditEvent(
        tx,
        {
          eventType: 'TALLY_COMPLETED',
          actor,
          electionId,
          payload: {
            totalBallots: result.totalBallots,
            merkleRoot: verified.root,
            resultHash: hash.toString('hex'),
            signature,
            keyId: signer.keyId,
          },
        },
        now,
      );
    });

    return { result, merkleRoot: verified.root, resultHash: hash.toString('hex'), signature };
  }

  async function requireTallied(electionId: string) {
    const election = await prisma.election.findUnique({
      where: { id: electionId },
      select: { name: true, status: true },
    });
    if (!election) throw new NotFoundError('Election');
    // Sem resultado parcial: nada é publicado antes da apuração.
    if (election.status !== 'TALLIED') {
      throw new ConflictError('Results are only published after the tally');
    }
    return election;
  }

  /** Tudo o que um verificador externo precisa para refazer a apuração e checar as assinaturas. */
  async function published(electionId: string) {
    const election = await requireTallied(electionId);
    const stored = await prisma.tallyResult.findUniqueOrThrow({ where: { electionId } });
    const seal = await loadSeal(electionId);
    return {
      electionId,
      electionName: election.name,
      result: tallyResultSchema.parse(stored.result),
      merkleRoot: Buffer.from(stored.merkleRoot).toString('hex'),
      resultHash: Buffer.from(stored.resultHash).toString('hex'),
      signature: stored.signature,
      keyId: stored.keyId,
      publicKey: signer.publicKey,
      seal: { ...sealDataOf(electionId, seal), signature: seal.signature, keyId: seal.keyId },
      turnout: {
        registeredVoters: seal.registeredVoters,
        authorizedVoters: seal.authorizedVoters,
        authorizedWithoutBallot: seal.authorizedWithoutBallot,
      },
      talliedAt: stored.createdAt.toISOString(),
      // v2: publicada após a apuração para que qualquer um refaça a decifragem.
      ...(stored.decryptionKey && {
        decryptionKey: Buffer.from(stored.decryptionKey).toString('base64url'),
      }),
    };
  }

  /** O "quadro público" de votos: anônimos, em ordem de commitment (nunca de chegada). */
  async function publishedBallots(electionId: string) {
    await requireTallied(electionId);
    const ballots = await loadBallots(electionId);
    const b64 = (bytes: Uint8Array | null | undefined) =>
      bytes ? Buffer.from(bytes).toString('base64url') : null;
    return ballots.map((b) => ({
      id: b.id,
      commitment: Buffer.from(b.commitment).toString('hex'),
      kind: b.kind,
      candidateId: b.candidateId,
      ...(b.ciphertext && {
        encapsulatedKey: b64(b.encapsulatedKey),
        ciphertext: b64(b.ciphertext),
      }),
    }));
  }

  return { tally, published, publishedBallots };
}

export const plainDecoder: BallotDecoder = (ballots) =>
  Promise.resolve(ballots.map(decodePlainBallot));

export type TallyService = ReturnType<typeof createTallyService>;
