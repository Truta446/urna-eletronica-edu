import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { split } from 'shamir-secret-sharing';
import { toBase64Url } from './encoding.js';

/**
 * Cerimônia de chaves NO NAVEGADOR do administrador: o par HPKE da eleição é gerado aqui e a
 * chave privada é dividida (Shamir) entre trustees. Só a chave PÚBLICA vai para o servidor.
 * A chave privada inteira não é exibida nem guardada.
 */
export async function runKeyCeremony(shares: number, threshold: number) {
  const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  const pair = await suite.kem.generateKeyPair();
  const publicKey = new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey));
  const privateKey = new Uint8Array(await suite.kem.serializePrivateKey(pair.privateKey));
  try {
    const parts = await split(privateKey, shares, threshold);
    return { publicKey: toBase64Url(publicKey), shares: parts.map(toBase64Url) };
  } finally {
    privateKey.fill(0);
  }
}
