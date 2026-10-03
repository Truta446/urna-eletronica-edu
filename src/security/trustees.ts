import { combine, split } from 'shamir-secret-sharing';

/**
 * Divisão da chave privada da eleição entre trustees com Shamir's Secret Sharing
 * (biblioteca `shamir-secret-sharing`, auditada por Cure53 e Zellic).
 * Com `threshold` partes, a chave é reconstruída; com menos, nada se aprende sobre ela.
 *
 * A biblioteca exige `Uint8Array` "puro" (rejeita Buffer), por isso as cópias explícitas.
 */
export async function splitKey(
  privateKey: Uint8Array,
  shares: number,
  threshold: number,
): Promise<string[]> {
  const secret = new Uint8Array(privateKey);
  try {
    const parts = await split(secret, shares, threshold);
    return parts.map((part) => Buffer.from(part).toString('base64url'));
  } finally {
    secret.fill(0);
  }
}

/**
 * ATENÇÃO: com menos partes que o limiar (mas >= 2), `combine` NÃO falha, devolve um valor
 * errado. Quem chama precisa conferir a chave reconstruída (ver keyPairMatches).
 */
export async function combineShares(shares: readonly string[]): Promise<Buffer<ArrayBuffer>> {
  const parts = shares.map((share) => new Uint8Array(Buffer.from(share, 'base64url')));
  return Buffer.from(await combine(parts));
}
