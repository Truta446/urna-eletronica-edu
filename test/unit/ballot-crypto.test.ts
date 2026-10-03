import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalRequest } from '../../src/modules/ballot-box/domain/ballot.js';
import {
  ballotCommitment,
  idempotencyScopeKey,
  nullifierFor,
  requestFingerprint,
} from '../../src/security/ballot-crypto.js';
import { generateToken, hashToken } from '../../src/security/tokens.js';

describe('nullifierFor', () => {
  it('is deterministic per token and 32 bytes', () => {
    const token = generateToken();
    expect(nullifierFor(token)).toEqual(nullifierFor(token));
    expect(nullifierFor(token)).toHaveLength(32);
  });

  it('is domain-separated from token_hash, so the two columns cannot be joined', () => {
    const token = generateToken();
    expect(nullifierFor(token)).not.toEqual(hashToken(token));
  });
});

describe('idempotency keys', () => {
  const key = randomUUID();

  it('scope depends on the token: same Idempotency-Key from two voters never collides', () => {
    expect(idempotencyScopeKey(generateToken(), key)).not.toEqual(
      idempotencyScopeKey(generateToken(), key),
    );
  });

  it('fingerprint cannot be brute-forced over the few possible choices without the token', () => {
    const electionId = randomUUID();
    const choices = [42, 13, 99].map((n) =>
      canonicalRequest(electionId, { type: 'candidate', number: n }),
    );
    const tokenA = generateToken();
    const tokenB = generateToken();
    // Mesmo payload, tokens diferentes: valores sem relação entre si.
    for (const payload of choices) {
      expect(requestFingerprint(tokenA, payload)).not.toEqual(requestFingerprint(tokenB, payload));
    }
  });

  it('fingerprint changes with the payload', () => {
    const token = generateToken();
    const electionId = randomUUID();
    expect(requestFingerprint(token, canonicalRequest(electionId, { type: 'blank' }))).not.toEqual(
      requestFingerprint(token, canonicalRequest(electionId, { type: 'null' })),
    );
  });
});

describe('canonicalRequest', () => {
  it('distinguishes every kind of choice', () => {
    const id = randomUUID();
    const values = new Set([
      canonicalRequest(id, { type: 'candidate', number: 1 }),
      canonicalRequest(id, { type: 'candidate', number: 2 }),
      canonicalRequest(id, { type: 'blank' }),
      canonicalRequest(id, { type: 'null' }),
    ]);
    expect(values.size).toBe(4);
  });
});

describe('ballotCommitment', () => {
  const base = {
    ballotId: randomUUID(),
    electionId: randomUUID(),
    kind: 'CANDIDATE',
    candidateId: randomUUID(),
  };

  it('is deterministic (recomputable from the stored row)', () => {
    expect(ballotCommitment(base)).toEqual(ballotCommitment({ ...base }));
  });

  it.each([
    ['ballotId', { ballotId: randomUUID() }],
    ['electionId', { electionId: randomUUID() }],
    ['kind', { kind: 'BLANK', candidateId: null }],
    ['candidateId', { candidateId: randomUUID() }],
  ])('changes when %s changes (detects tampering)', (_field, change) => {
    expect(ballotCommitment({ ...base, ...change })).not.toEqual(ballotCommitment(base));
  });
});
