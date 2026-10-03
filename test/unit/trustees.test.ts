import { describe, expect, it } from 'vitest';
import { generateElectionKeyPair, keyPairMatches } from '../../src/security/ballot-encryption.js';
import { combineShares, splitKey } from '../../src/security/trustees.js';

const keys = await generateElectionKeyPair();
const shares = await splitKey(keys.privateKey, 5, 3);

describe('trustee key sharing (Shamir, 3 of 5)', () => {
  it('any 3 shares reconstruct the key', async () => {
    for (const subset of [
      [0, 1, 2],
      [0, 2, 4],
      [1, 3, 4],
      [2, 3, 4],
    ]) {
      const key = await combineShares(subset.map((i) => shares[i] ?? ''));
      expect(key.equals(keys.privateKey)).toBe(true);
    }
  });

  it('2 shares do NOT reconstruct it — and combine silently returns garbage', async () => {
    const key = await combineShares([shares[0] ?? '', shares[1] ?? '']);
    expect(key.equals(keys.privateKey)).toBe(false);
    expect(await keyPairMatches(keys.publicKey, key)).toBe(false);
  });

  it('a single share reveals nothing usable', async () => {
    await expect(combineShares([shares[0] ?? ''])).rejects.toThrow();
  });

  it('does not leave the key inside any share', () => {
    const keyHex = keys.privateKey.toString('hex');
    for (const share of shares)
      expect(Buffer.from(share, 'base64url').toString('hex')).not.toContain(keyHex);
  });
});
