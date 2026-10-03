/**
 * @types/node expõe `CryptoKey` como VALOR global, mas não como TIPO. Bibliotecas WebCrypto
 * (ex.: @hpke/core) usam `CryptoKey` como tipo; sem isto, com skipLibCheck, o tipo vira
 * silenciosamente "error type" (any na prática). Encontrado pelo ESLint (no-unsafe-assignment).
 */
declare global {
  type CryptoKey = import('node:crypto').webcrypto.CryptoKey;
  type CryptoKeyPair = import('node:crypto').webcrypto.CryptoKeyPair;
}

export {};
