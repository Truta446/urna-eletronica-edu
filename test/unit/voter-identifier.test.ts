import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVoterIdentifierHasher } from '../../src/security/voter-identifier.js';

const electionA = '6f1c1c1e-4b7a-4c1e-9b0a-2f6f3d0c9a11';
const electionB = '0c9a2f6f-3d0c-4a11-8b7a-6f1c1c1e4b7a';
const cpf = '52998224725';

describe('voter identifier HMAC', () => {
  const pepper = randomBytes(32);
  const hash = createVoterIdentifierHasher(pepper);

  it('is deterministic within an election (allows UNIQUE + lookup)', () => {
    expect(hash(electionA, cpf)).toEqual(hash(electionA, cpf));
    expect(hash(electionA, cpf)).toHaveLength(32);
  });

  it('differs between elections, so dumps cannot be cross-referenced', () => {
    expect(hash(electionA, cpf)).not.toEqual(hash(electionB, cpf));
  });

  it('differs with another pepper', () => {
    const other = createVoterIdentifierHasher(randomBytes(32));
    expect(other(electionA, cpf)).not.toEqual(hash(electionA, cpf));
  });

  it('is not a plain (brute-forceable) SHA-256 of the CPF', () => {
    const plain = createHash('sha256').update(cpf).digest();
    expect(hash(electionA, cpf)).not.toEqual(plain);
  });

  it('never contains the identifier', () => {
    expect(hash(electionA, cpf).toString('latin1')).not.toContain(cpf);
    expect(hash(electionA, cpf).toString('hex')).not.toContain(cpf);
  });

  it('refuses short peppers', () => {
    expect(() => createVoterIdentifierHasher(randomBytes(16))).toThrow();
  });
});
