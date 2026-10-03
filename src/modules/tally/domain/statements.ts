import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { TallyResultData } from './tally.js';

/**
 * Textos canônicos (RFC 8785) que são ASSINADOS. Quem verifica reconstrói exatamente a mesma
 * string a partir dos dados publicados e confere a assinatura Ed25519.
 */
function canonical(value: object): string {
  const text = canonicalize(value);
  if (text === undefined) throw new Error('Statement is not serializable');
  return text;
}

export interface SealData {
  electionId: string;
  ballots: number;
  /** Merkle root (RFC 6962, hex) dos commitments ordenados. */
  merkleRoot: string;
  /** Checkpoint da cadeia de auditoria: o evento ELECTION_CLOSED. */
  auditHeadSeq: number;
  auditHeadHash: string;
  sealedAt: string;
}

export function sealStatement(seal: SealData): string {
  return canonical({ type: 'urna-edu/seal/v1', ...seal });
}

export interface ResultData {
  electionId: string;
  merkleRoot: string;
  result: TallyResultData;
  /** Encadeia o resultado ao lacre: não dá para assinar um resultado sobre outra urna. */
  sealSignature: string;
}

export function resultStatement(data: ResultData): string {
  return canonical({ type: 'urna-edu/result/v1', ...data });
}

/**
 * Cada habilitação gera um evento assinado com um nonce aleatório (Fase 10, ataque A1).
 * Sem referência ao eleitor nem à sessão: só prova que o SERVIDOR (dono da chave) habilitou
 * alguém nesta eleição. Na apuração, nº de assinaturas válidas e únicas == nº de habilitados.
 */
export function authorizationStatement(data: {
  electionId: string;
  nonce: string;
  issuedAt: string;
}): string {
  return canonical({ type: 'urna-edu/authorization/v1', ...data });
}

export function resultHash(statement: string): Buffer<ArrayBuffer> {
  return createHash('sha256').update(statement, 'utf8').digest();
}
