import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes = 256 bits de entropia. Em base64url, sempre 43 caracteres. */
export const TOKEN_BYTES = 32;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256 é suficiente para tokens de alta entropia: não há o que forçar por dicionário,
 * e um hash rápido permite busca por índice. (Para segredos de baixa entropia, ver HMAC + pepper.)
 */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
