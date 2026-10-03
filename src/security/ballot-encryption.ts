import { randomBytes } from 'node:crypto';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';

/**
 * Cifragem de votos com HPKE (RFC 9180), modo Base, suíte
 *   KEM  DHKEM(X25519, HKDF-SHA256) · KDF HKDF-SHA256 · AEAD AES-256-GCM
 * via @hpke/core (implementação testada contra os vetores da RFC). Nada caseiro aqui:
 * este módulo só escolhe a suíte, o formato do texto claro e o contexto (info/AAD).
 */
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

const INFO = new TextEncoder().encode('urna-edu/ballot/v2');

export const PUBLIC_KEY_BYTES = 32;
export const ENCAPSULATED_KEY_BYTES = 32;
/** 17 bytes de texto claro + 16 de tag GCM. Tamanho FIXO: o tamanho não revela a escolha. */
export const CIPHERTEXT_BYTES = 33;

export type PlainChoice =
  { kind: 'CANDIDATE'; candidateId: string } | { kind: 'BLANK' } | { kind: 'NULL_VOTE' };

const KIND_CODE = { CANDIDATE: 1, BLANK: 2, NULL_VOTE: 3 } as const;

/** [1 byte: tipo][16 bytes: UUID do candidato, ou zeros]. Sempre 17 bytes. */
export function encodeChoice(choice: PlainChoice): Uint8Array {
  const bytes = new Uint8Array(17);
  bytes[0] = KIND_CODE[choice.kind];
  if (choice.kind === 'CANDIDATE')
    bytes.set(Buffer.from(choice.candidateId.replaceAll('-', ''), 'hex'), 1);
  return bytes;
}

export class InvalidPlaintextError extends Error {}

export function decodeChoice(bytes: Uint8Array): PlainChoice {
  if (bytes.length !== 17) throw new InvalidPlaintextError('length');
  const rest = Buffer.from(bytes.subarray(1));
  const isZero = rest.every((b) => b === 0);
  switch (bytes[0]) {
    case KIND_CODE.CANDIDATE: {
      if (isZero) throw new InvalidPlaintextError('candidate');
      const hex = rest.toString('hex');
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      return { kind: 'CANDIDATE', candidateId: uuid };
    }
    case KIND_CODE.BLANK:
      if (!isZero) throw new InvalidPlaintextError('blank');
      return { kind: 'BLANK' };
    case KIND_CODE.NULL_VOTE:
      if (!isZero) throw new InvalidPlaintextError('null');
      return { kind: 'NULL_VOTE' };
    default:
      throw new InvalidPlaintextError('kind');
  }
}

/**
 * AAD amarra o texto cifrado à eleição e ao id do voto: copiar o ciphertext para outro voto ou
 * outra eleição faz a decifragem falhar (o AEAD rejeita).
 */
function aadFor(electionId: string, ballotId: string): Uint8Array {
  return new TextEncoder().encode(`urna-edu/ballot/v2|${electionId}|${ballotId}`);
}

export interface EncryptedBallot {
  encapsulatedKey: Buffer<ArrayBuffer>;
  ciphertext: Buffer<ArrayBuffer>;
}

export async function encryptChoice(
  publicKey: Uint8Array,
  context: { electionId: string; ballotId: string },
  choice: PlainChoice,
): Promise<EncryptedBallot> {
  const recipientPublicKey = await suite.kem.importKey('raw', publicKey, true);
  const { enc, ct } = await suite.seal(
    { recipientPublicKey, info: INFO },
    encodeChoice(choice),
    aadFor(context.electionId, context.ballotId),
  );
  return { encapsulatedKey: Buffer.from(enc), ciphertext: Buffer.from(ct) };
}

export class DecryptionError extends Error {}

export async function decryptChoice(
  privateKey: Uint8Array,
  context: { electionId: string; ballotId: string },
  ballot: { encapsulatedKey: Uint8Array; ciphertext: Uint8Array },
): Promise<PlainChoice> {
  try {
    const recipientKey = await suite.kem.importKey('raw', privateKey, false);
    const plaintext = await suite.open(
      { recipientKey, enc: ballot.encapsulatedKey, info: INFO },
      ballot.ciphertext,
      aadFor(context.electionId, context.ballotId),
    );
    return decodeChoice(new Uint8Array(plaintext));
  } catch (error) {
    throw new DecryptionError(error instanceof Error ? error.name : 'decrypt');
  }
}

/** Valida que os bytes formam uma chave pública X25519 utilizável. */
export async function isValidPublicKey(publicKey: Uint8Array): Promise<boolean> {
  if (publicKey.length !== PUBLIC_KEY_BYTES) return false;
  try {
    await suite.kem.importKey('raw', publicKey, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confere que a chave privada (ex.: reconstruída das partes dos trustees) corresponde à pública,
 * cifrando e decifrando um valor aleatório. Com partes insuficientes, o Shamir não falha:
 * devolve um valor errado. Esta checagem é o que detecta isso.
 */
export async function keyPairMatches(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<boolean> {
  try {
    const probe = randomBytes(16);
    const recipientPublicKey = await suite.kem.importKey('raw', publicKey, true);
    const recipientKey = await suite.kem.importKey('raw', privateKey, false);
    const { enc, ct } = await suite.seal({ recipientPublicKey, info: INFO }, probe);
    const opened = await suite.open({ recipientKey, enc, info: INFO }, ct);
    return Buffer.from(opened).equals(probe);
  } catch {
    return false;
  }
}

export async function generateElectionKeyPair(): Promise<{
  publicKey: Buffer;
  privateKey: Buffer;
}> {
  const pair = await suite.kem.generateKeyPair();
  return {
    publicKey: Buffer.from(await suite.kem.serializePublicKey(pair.publicKey)),
    privateKey: Buffer.from(await suite.kem.serializePrivateKey(pair.privateKey)),
  };
}
