import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateElectionKeyPair } from '../../src/security/ballot-encryption.js';
import { splitKey } from '../../src/security/trustees.js';
import {
  verifyPublished,
  type PublishedBallot,
  type PublishedTally,
} from '../../web/src/lib/verify.js';
import { resetDatabase } from '../helpers/database.js';
import {
  castBallot,
  closeElection,
  createElectionWithTokens,
  type ChoicePayload,
} from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { adminHeaders, createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * Teste CRUZADO: o verificador do front (web/src/lib/verify.ts) foi reescrito do zero com
 * WebCrypto, sem importar código do backend. Ele precisa concordar com o backend sobre dados
 * reais de eleições v1 e v2, e detectar as mesmas adulterações.
 */
const clock = createFakeClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set(new Date('2030-01-01T12:00:00Z'));
  await resetDatabase(t.prisma);
});
afterAll(() => t.close());

const PLAN: ChoicePayload[] = [
  { type: 'candidate', number: 10 },
  { type: 'candidate', number: 20 },
  { type: 'candidate', number: 10 },
  { type: 'blank' },
  { type: 'null' },
];

async function talliedElection(encrypted: boolean) {
  const keys = encrypted ? await generateElectionKeyPair() : undefined;
  const shares = keys ? await splitKey(keys.privateKey, 3, 2) : undefined;
  const { election, tokens } = await createElectionWithTokens(t, clock, {
    voters: PLAN.length,
    ...(keys && { encryptionPublicKey: keys.publicKey.toString('base64url') }),
  });
  for (const [i, choice] of PLAN.entries()) {
    await castBallot(t, { token: tokens[i] ?? '', electionId: election.id, choice });
  }
  await closeElection(t, clock, election);
  const tallied = await t.app.inject({
    method: 'POST',
    url: `/admin/elections/${election.id}/tally`,
    headers: adminHeaders,
    ...(shares && { payload: { trusteeShares: shares.slice(0, 2) } }),
  });
  expect(tallied.statusCode).toBe(201);
  const ballots = await t.app.inject({ method: 'GET', url: `/elections/${election.id}/ballots` });
  return {
    tally: tallied.json<PublishedTally>(),
    ballots: ballots.json<{ ballots: PublishedBallot[] }>().ballots,
  };
}

describe.each([
  ['v1 (plain)', false],
  ['v2 (encrypted)', true],
])('browser verifier vs backend — %s', (_label, encrypted) => {
  it('accepts a genuine result: every check passes', async () => {
    const { tally, ballots } = await talliedElection(encrypted);
    const checks = await verifyPublished(tally, ballots);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(9);
  });

  it.each([
    [
      'inflated votes',
      (p: { tally: PublishedTally; ballots: PublishedBallot[] }) => {
        const first = p.tally.result.candidates[0];
        if (first) first.votes += 1;
      },
    ],
    [
      'a removed ballot',
      (p: { tally: PublishedTally; ballots: PublishedBallot[] }) => {
        p.ballots.pop();
      },
    ],
    [
      'a forged seal root',
      (p: { tally: PublishedTally; ballots: PublishedBallot[] }) => {
        p.tally.seal.merkleRoot = '00'.repeat(32);
      },
    ],
    [
      'a commitment swapped between ballots',
      (p: { tally: PublishedTally; ballots: PublishedBallot[] }) => {
        const [a, b] = p.ballots;
        if (a && b) [a.commitment, b.commitment] = [b.commitment, a.commitment];
      },
    ],
  ])('rejects %s', async (_l, tamper) => {
    const published = await talliedElection(encrypted);
    tamper(published);
    const checks = await verifyPublished(published.tally, published.ballots);
    expect(checks.some((c) => !c.ok)).toBe(true);
  });
});
