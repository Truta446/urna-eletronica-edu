import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTrusteeDecoder } from '../../src/modules/tally/application/encrypted-ballots.js';
import { generateElectionKeyPair } from '../../src/security/ballot-encryption.js';
import { splitKey } from '../../src/security/trustees.js';
import {
  publishedBallotsSchema,
  publishedTallySchema,
  verifyPublishedResult,
} from '../../src/verifier/verify-published.js';
import { resetDatabase } from '../helpers/database.js';
import {
  castBallot,
  closeElection,
  createElection,
  createElectionWithTokens,
  type ChoicePayload,
} from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { adminHeaders, createTestApp, type TestApp } from '../helpers/test-app.js';

const clock = createFakeClock();
const START = clock.now();
let t: TestApp;

const keys = await generateElectionKeyPair();
const shares = await splitKey(keys.privateKey, 5, 3);
const publicKey = keys.publicKey.toString('base64url');

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set(START);
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

async function closedEncryptedElection() {
  const { election, tokens } = await createElectionWithTokens(t, clock, {
    voters: PLAN.length,
    encryptionPublicKey: publicKey,
  });
  for (const [i, choice] of PLAN.entries()) {
    expect(
      (await castBallot(t, { token: tokens[i] ?? '', electionId: election.id, choice })).statusCode,
    ).toBe(201);
  }
  await closeElection(t, clock, election);
  return election;
}

const tally = (electionId: string, trusteeShares?: string[]) =>
  t.app.inject({
    method: 'POST',
    url: `/admin/elections/${electionId}/tally`,
    headers: adminHeaders,
    ...(trusteeShares && { payload: { trusteeShares } }),
  });

describe('encrypted election (v2)', () => {
  it('announces its encryption scheme and public key', async () => {
    const election = await createElection(t, clock.now(), { encryptionPublicKey: publicKey });
    expect(election).toMatchObject({
      ballotEncryption: 'HPKE-X25519-HKDFSHA256-AES256GCM',
      encryptionPublicKey: publicKey,
    });
  });

  it('stores ballots WITHOUT the choice: no kind, no candidate, fixed-size ciphertext', async () => {
    await closedEncryptedElection();
    const rows = await t.prisma.ballot.findMany();
    expect(rows).toHaveLength(PLAN.length);
    const candidateIds = (await t.prisma.candidate.findMany()).map((c) => c.id);
    for (const row of rows) {
      expect(row.kind).toBeNull();
      expect(row.candidateId).toBeNull();
      expect(row.encapsulatedKey).toHaveLength(32);
      expect(row.ciphertext).toHaveLength(33);
      const dump = Buffer.from(row.ciphertext ?? []).toString('hex');
      for (const id of candidateIds) expect(dump).not.toContain(id.replaceAll('-', ''));
    }
  });

  it('tallies with 3 of 5 trustee shares and publishes a verifiable result', async () => {
    const election = await closedEncryptedElection();
    const response = await tally(election.id, [shares[0] ?? '', shares[2] ?? '', shares[4] ?? '']);
    expect(response.statusCode).toBe(201);

    const published = publishedTallySchema.parse(response.json());
    expect(published.result.candidates.map((c) => [c.number, c.votes])).toEqual([
      [10, 2],
      [20, 1],
    ]);
    expect(published.result).toMatchObject({ blank: 1, null: 1, totalBallots: 5 });
    expect(published.decryptionKey).toBe(keys.privateKey.toString('base64url'));

    const ballots = publishedBallotsSchema.parse(
      (await t.app.inject({ method: 'GET', url: `/elections/${election.id}/ballots` })).json(),
    );
    expect(ballots.ballots.every((b) => b.ciphertext && b.kind === null)).toBe(true);
    const report = await verifyPublishedResult(
      published,
      ballots,
      createTrusteeDecoder(Buffer.from(published.decryptionKey ?? '', 'base64url')),
    );
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('refuses to tally without shares (422)', async () => {
    const election = await closedEncryptedElection();
    expect((await tally(election.id)).statusCode).toBe(422);
  });

  it('refuses shares below the threshold (2 of 3) without opening any ballot (422)', async () => {
    const election = await closedEncryptedElection();
    const response = await tally(election.id, [shares[0] ?? '', shares[1] ?? '']);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { message: expect.stringContaining('do not reconstruct') as unknown },
    });
    expect((await t.prisma.election.findUniqueOrThrow({ where: { id: election.id } })).status).toBe(
      'CLOSED',
    );
  });

  it('refuses shares for an unencrypted election (422)', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    await castBallot(t, { token: tokens[0] ?? '', electionId: election.id });
    await closeElection(t, clock, election);
    expect((await tally(election.id, shares.slice(0, 3))).statusCode).toBe(422);
  });

  it('never logs trustee shares', async () => {
    const election = await closedEncryptedElection();
    t.logs.length = 0;
    await tally(election.id, shares.slice(0, 3));
    const logs = JSON.stringify(t.logs);
    for (const share of shares) expect(logs).not.toContain(share);
  });

  it('a tampered ciphertext is detected before counting', async () => {
    const election = await closedEncryptedElection();
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE ballots DISABLE TRIGGER ALL'),
      t.prisma.$executeRawUnsafe(
        `UPDATE ballots SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)
          WHERE id = (SELECT id FROM ballots LIMIT 1)`,
      ),
      t.prisma.$executeRawUnsafe('ALTER TABLE ballots ENABLE TRIGGER ALL'),
    ]);
    const response = await tally(election.id, shares.slice(0, 3));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INTEGRITY_FAILURE' } });
  });

  it('rejects a malformed public key at creation (400)', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/admin/elections',
      headers: adminHeaders,
      payload: {
        name: 'X',
        startsAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
        endsAt: new Date(clock.now().getTime() + 7_200_000).toISOString(),
        encryptionPublicKey: 'short',
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
