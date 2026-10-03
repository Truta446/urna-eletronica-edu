import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSigner, verifySignature } from '../../src/security/signing.js';

describe('Ed25519 signer', () => {
  const signer = createSigner(generateKeyPairSync('ed25519').privateKey);
  const statement = '{"type":"urna-edu/result/v1","votes":42}';

  it('produces signatures that verify with the published public key', () => {
    expect(verifySignature(signer.publicKey, statement, signer.sign(statement))).toBe(true);
  });

  it('rejects a modified statement', () => {
    expect(
      verifySignature(signer.publicKey, statement.replace('42', '43'), signer.sign(statement)),
    ).toBe(false);
  });

  it('rejects a signature from another key', () => {
    const other = createSigner(generateKeyPairSync('ed25519').privateKey);
    expect(verifySignature(signer.publicKey, statement, other.sign(statement))).toBe(false);
  });

  it('returns false (does not throw) for garbage keys or signatures', () => {
    expect(verifySignature('not-a-key', statement, signer.sign(statement))).toBe(false);
    expect(verifySignature(signer.publicKey, statement, 'not-a-signature')).toBe(false);
  });

  it('derives a stable keyId from the public key', () => {
    expect(signer.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(createSigner(generateKeyPairSync('ed25519').privateKey).keyId).not.toBe(signer.keyId);
  });
});
