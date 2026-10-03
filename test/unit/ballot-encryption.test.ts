import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CIPHERTEXT_BYTES,
  decodeChoice,
  decryptChoice,
  DecryptionError,
  encodeChoice,
  encryptChoice,
  generateElectionKeyPair,
  InvalidPlaintextError,
  isValidPublicKey,
  keyPairMatches,
  type PlainChoice,
} from '../../src/security/ballot-encryption.js';

const keys = await generateElectionKeyPair();
const context = { electionId: randomUUID(), ballotId: randomUUID() };
const CHOICES: PlainChoice[] = [
  { kind: 'CANDIDATE', candidateId: randomUUID() },
  { kind: 'BLANK' },
  { kind: 'NULL_VOTE' },
];

describe('choice encoding', () => {
  it.each(CHOICES)('round-trips %j in exactly 17 bytes', (choice) => {
    const bytes = encodeChoice(choice);
    expect(bytes).toHaveLength(17);
    expect(decodeChoice(bytes)).toEqual(choice);
  });

  it.each([
    ['unknown kind', Uint8Array.from([9, ...new Uint8Array(16)])],
    ['candidate without id', Uint8Array.from([1, ...new Uint8Array(16)])],
    ['blank with trailing data', Uint8Array.from([2, ...randomBytes(16)])],
    ['wrong length', new Uint8Array(16)],
  ])('rejects %s', (_label, bytes) => {
    expect(() => decodeChoice(bytes)).toThrow(InvalidPlaintextError);
  });
});

describe('HPKE ballot encryption', () => {
  it.each(CHOICES)('decrypts back to %j', async (choice) => {
    const encrypted = await encryptChoice(keys.publicKey, context, choice);
    expect(await decryptChoice(keys.privateKey, context, encrypted)).toEqual(choice);
  });

  it('produces fixed-size output: the length never reveals the choice', async () => {
    const sizes = await Promise.all(
      CHOICES.map(async (c) => {
        const e = await encryptChoice(keys.publicKey, context, c);
        return [e.encapsulatedKey.length, e.ciphertext.length];
      }),
    );
    expect(new Set(sizes.map((s) => s.join('/')))).toEqual(new Set([`32/${CIPHERTEXT_BYTES}`]));
  });

  it('is randomized: the same choice never yields the same ciphertext', async () => {
    const choice = CHOICES[1] ?? { kind: 'BLANK' };
    const a = await encryptChoice(keys.publicKey, context, choice);
    const b = await encryptChoice(keys.publicKey, context, choice);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it.each([
    ['another ballot id', { ...context, ballotId: randomUUID() }],
    ['another election', { ...context, electionId: randomUUID() }],
  ])('fails when moved to %s (AAD binding)', async (_label, otherContext) => {
    const encrypted = await encryptChoice(keys.publicKey, context, { kind: 'BLANK' });
    await expect(decryptChoice(keys.privateKey, otherContext, encrypted)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('fails when a single bit of the ciphertext changes', async () => {
    const encrypted = await encryptChoice(keys.publicKey, context, { kind: 'BLANK' });
    encrypted.ciphertext[0] = (encrypted.ciphertext[0] ?? 0) ^ 1;
    await expect(decryptChoice(keys.privateKey, context, encrypted)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('fails with another private key', async () => {
    const encrypted = await encryptChoice(keys.publicKey, context, { kind: 'BLANK' });
    const other = await generateElectionKeyPair();
    await expect(decryptChoice(other.privateKey, context, encrypted)).rejects.toThrow(
      DecryptionError,
    );
  });
});

describe('key checks', () => {
  it('keyPairMatches tells matching from non-matching keys', async () => {
    const other = await generateElectionKeyPair();
    expect(await keyPairMatches(keys.publicKey, keys.privateKey)).toBe(true);
    expect(await keyPairMatches(keys.publicKey, other.privateKey)).toBe(false);
  });

  it('isValidPublicKey rejects wrong sizes', async () => {
    expect(await isValidPublicKey(keys.publicKey)).toBe(true);
    expect(await isValidPublicKey(randomBytes(31))).toBe(false);
  });
});
