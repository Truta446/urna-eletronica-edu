/**
 * "Cerimônia de chaves" (simulada) de uma eleição cifrada.
 * Uso: npm run trustees:keygen -- <partes> <limiar>      ex.: -- 5 3
 *
 * Gera um par X25519 (HPKE), divide a chave PRIVADA com Shamir em <partes>, das quais <limiar>
 * reconstroem a chave. A chave pública vai em `encryptionPublicKey` ao criar a eleição.
 * Cada parte deve ir para um trustee diferente. A chave privada inteira NÃO é impressa.
 *
 * Limitação: numa cerimônia real a chave é gerada num computador isolado e a memória não
 * guarda cópias; em JavaScript não há como garantir que a chave foi apagada da memória.
 */
import { generateElectionKeyPair } from '../src/security/ballot-encryption.js';
import { splitKey } from '../src/security/trustees.js';

const shares = Number(process.argv[2] ?? 3);
const threshold = Number(process.argv[3] ?? 2);
if (
  !Number.isInteger(shares) ||
  !Number.isInteger(threshold) ||
  threshold < 2 ||
  shares < threshold ||
  shares > 255
) {
  process.stderr.write(
    'Uso: npm run trustees:keygen -- <partes> <limiar>   (2 <= limiar <= partes <= 255)\n',
  );
  process.exit(1);
}

const { publicKey, privateKey } = await generateElectionKeyPair();
const parts = await splitKey(privateKey, shares, threshold);
privateKey.fill(0);

process.stdout.write(
  [
    `encryptionPublicKey (use ao criar a eleição): ${publicKey.toString('base64url')}`,
    ``,
    `${shares} partes; quaisquer ${threshold} reconstroem a chave. Entregue uma a cada trustee:`,
    ...parts.map((part, i) => `  trustee ${i + 1}: ${part}`),
    ``,
  ].join('\n'),
);
