/**
 * Gera uma chave Ed25519 para assinar lacres e resultados.
 * Uso: npm run signing-key:generate
 * A chave privada vai para SIGNING_PRIVATE_KEY; a pública é publicada junto com os resultados.
 */
import { generateKeyPairSync } from 'node:crypto';
import { createSigner } from '../src/security/signing.js';

const { privateKey } = generateKeyPairSync('ed25519');
const signer = createSigner(privateKey);
process.stdout.write(
  [
    `SIGNING_PRIVATE_KEY=${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')}`,
    ``,
    `Chave pública (SPKI DER, base64url): ${signer.publicKey}`,
    `keyId: ${signer.keyId}`,
    ``,
  ].join('\n'),
);
