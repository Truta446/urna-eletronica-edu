import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';

/**
 * Assinaturas Ed25519 (node:crypto). Usadas para o lacre da urna e para o resultado da apuração:
 * quem tem só o banco (sem a chave) não consegue forjar um lacre ou um resultado.
 */
export interface Signer {
  /** Identificador da chave: primeiros 8 bytes do SHA-256 da chave pública (SPKI). Permite rotação. */
  keyId: string;
  /** Chave pública em SPKI DER, base64url: o que um verificador externo precisa. */
  publicKey: string;
  sign(statement: string): string;
}

export function keyIdOf(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(spki).digest('hex').slice(0, 16);
}

export function createSigner(privateKey: KeyObject): Signer {
  const publicKey = createPublicKey(privateKey);
  return {
    keyId: keyIdOf(publicKey),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    sign: (statement) =>
      sign(null, Buffer.from(statement, 'utf8'), privateKey).toString('base64url'),
  };
}

export function verifySignature(
  publicKeySpki: string,
  statement: string,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(statement, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** `SIGNING_PRIVATE_KEY`: chave Ed25519 em PKCS#8 DER, base64url. Gere com `npm run signing-key:generate`. */
export const signingKeySchema = z.string().transform((value, ctx) => {
  try {
    const key = createPrivateKey({
      key: Buffer.from(value, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    });
    if (key.asymmetricKeyType === 'ed25519') return key;
  } catch {
    // cai no erro abaixo, sem ecoar o valor
  }
  ctx.addIssue({
    code: 'custom',
    message: 'Must be an Ed25519 private key (PKCS#8 DER, base64url)',
  });
  return z.NEVER;
});
