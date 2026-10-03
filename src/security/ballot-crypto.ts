import { createHash, createHmac } from 'node:crypto';

/**
 * Todas as derivações usam separação de domínio (prefixo + \0): o mesmo token nunca gera o
 * mesmo valor em dois contextos. Nenhuma delas é criptografia nova: são SHA-256 e HMAC-SHA256.
 */
function sha256(...parts: string[]): Buffer<ArrayBuffer> {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest();
}

function hmac(key: string, ...parts: string[]): Buffer<ArrayBuffer> {
  return createHmac('sha256', key).update(parts.join('\0'), 'utf8').digest();
}

/**
 * Um token, um nullifier. Sem chave secreta: o token tem 256 bits e nunca é armazenado, então
 * ninguém liga `nullifier` (aqui) a `token_hash` (SHA-256 do token) sem conhecer o token.
 */
export function nullifierFor(token: string): Buffer<ArrayBuffer> {
  return sha256('urna-edu/nullifier/v1', token);
}

/**
 * Chave do registro de idempotência. HMAC com o TOKEN como chave: quem lê o banco não consegue
 * recalcular nem testar valores, porque não tem o token.
 */
export function idempotencyScopeKey(token: string, idempotencyKey: string): Buffer<ArrayBuffer> {
  return hmac(token, 'urna-edu/idempotency-scope/v1', idempotencyKey);
}

/**
 * Impressão digital da requisição, para detectar a mesma Idempotency-Key com outro payload.
 * NÃO pode ser SHA-256(payload): com poucos candidatos, o hash revelaria o voto por força bruta.
 */
export function requestFingerprint(token: string, canonicalRequest: string): Buffer<ArrayBuffer> {
  return hmac(token, 'urna-edu/request-fingerprint/v1', canonicalRequest);
}

export interface CommitmentInput {
  ballotId: string;
  electionId: string;
  kind: string;
  candidateId: string | null;
}

/** Folha da Merkle root na apuração (Fase 7). Determinística e recalculável a partir da linha. */
export function ballotCommitment(input: CommitmentInput): Buffer<ArrayBuffer> {
  return sha256(
    'urna-edu/ballot/v1',
    input.ballotId,
    input.electionId,
    input.kind,
    input.candidateId ?? '',
  );
}

/**
 * Commitment de voto cifrado (v2): sobre o TEXTO CIFRADO, não sobre a escolha. Recalculável e
 * verificável (Merkle root) por qualquer um, sem a chave de decifragem.
 */
export function encryptedBallotCommitment(input: {
  ballotId: string;
  electionId: string;
  encapsulatedKey: Uint8Array;
  ciphertext: Uint8Array;
}): Buffer<ArrayBuffer> {
  return sha256(
    'urna-edu/ballot/v2',
    input.ballotId,
    input.electionId,
    Buffer.from(input.encapsulatedKey).toString('hex'),
    Buffer.from(input.ciphertext).toString('hex'),
  );
}
