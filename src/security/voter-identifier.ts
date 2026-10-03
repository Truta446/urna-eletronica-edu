import { createHmac, hkdfSync } from 'node:crypto';
import { z } from 'zod';

export const PEPPER_MIN_BYTES = 32;

/** Pepper em base64url com pelo menos 256 bits. Gere com `npm run secret:generate`. */
export const pepperSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be base64url')
  .transform((value) => Buffer.from(value, 'base64url'))
  .refine(
    (bytes) => bytes.length >= PEPPER_MIN_BYTES,
    `Must decode to at least ${PEPPER_MIN_BYTES} bytes`,
  );

const HKDF_INFO = 'urna-edu/voter-identifier/v1';

/**
 * HMAC-SHA256 com uma chave POR ELEIÇÃO, derivada do pepper via HKDF (salt = electionId).
 *
 * - Sem o pepper, o hash é inútil para força bruta (o pepper não está no banco).
 * - O mesmo CPF gera valores diferentes em eleições diferentes: um dump não permite
 *   cruzar a participação de uma pessoa entre eleições.
 * - Determinístico dentro da eleição, então permite índice UNIQUE e busca.
 */
export function createVoterIdentifierHasher(pepper: Buffer) {
  if (pepper.length < PEPPER_MIN_BYTES) throw new Error('Pepper too short');

  return (electionId: string, normalizedIdentifier: string): Buffer<ArrayBuffer> => {
    const key = Buffer.from(hkdfSync('sha256', pepper, electionId, HKDF_INFO, 32));
    return createHmac('sha256', key).update(normalizedIdentifier, 'utf8').digest();
  };
}

export type VoterIdentifierHasher = ReturnType<typeof createVoterIdentifierHasher>;
