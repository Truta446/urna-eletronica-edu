import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  publishedBallotsSchema,
  publishedTallySchema,
  verifyPublishedResult,
  type PublishedBallots,
  type PublishedTally,
} from '../../src/verifier/verify-published.js';
import { resetDatabase } from '../helpers/database.js';
import {
  castBallot,
  closeElection,
  createElectionWithTokens,
  tallyElection,
  type ChoicePayload,
} from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { adminHeaders, createTestApp, type TestApp } from '../helpers/test-app.js';

const clock = createFakeClock();
const START = clock.now();
let t: TestApp;

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
  { type: 'candidate', number: 10 },
  { type: 'candidate', number: 20 },
  { type: 'blank' },
  { type: 'null' },
  { type: 'candidate', number: 10 },
];

/** 7 eleitores habilitados, 6 votam conforme PLAN, eleição fechada. */
async function closedElection() {
  const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 7 });
  for (const [i, choice] of PLAN.entries()) {
    expect(
      (await castBallot(t, { token: tokens[i] ?? '', electionId: election.id, choice })).statusCode,
    ).toBe(201);
  }
  await closeElection(t, clock, election);
  return election;
}

async function getPublished(
  electionId: string,
): Promise<{ tally: PublishedTally; ballots: PublishedBallots }> {
  const tally = await t.app.inject({ method: 'GET', url: `/elections/${electionId}/tally` });
  const ballots = await t.app.inject({ method: 'GET', url: `/elections/${electionId}/ballots` });
  expect(tally.statusCode).toBe(200);
  expect(ballots.statusCode).toBe(200);
  return {
    tally: publishedTallySchema.parse(tally.json()),
    ballots: publishedBallotsSchema.parse(ballots.json()),
  };
}

describe('POST /admin/elections/:id/tally', () => {
  it('counts the votes correctly (INV-4: counted == valid ballots)', async () => {
    const election = await closedElection();
    const response = await tallyElection(t, election.id);
    expect(response.statusCode).toBe(201);

    const { tally } = await getPublished(election.id);
    expect(tally.result.candidates.map((c) => [c.number, c.votes])).toEqual([
      [10, 3],
      [20, 1],
    ]);
    expect(tally.result).toMatchObject({ blank: 1, null: 1, totalBallots: 6 });
    const counted =
      tally.result.candidates.reduce((s, c) => s + c.votes, 0) +
      tally.result.blank +
      tally.result.null;
    expect(counted).toBe(await t.prisma.ballot.count());
  });

  it('publishes turnout including authorized voters who did not vote', async () => {
    const election = await closedElection();
    await tallyElection(t, election.id);
    const response = await t.app.inject({ method: 'GET', url: `/elections/${election.id}/tally` });
    expect(response.json()).toMatchObject({
      turnout: { registeredVoters: 7, authorizedVoters: 7, authorizedWithoutBallot: 1 },
    });
  });

  it('moves the election to TALLIED and writes TALLY_STARTED/TALLY_COMPLETED', async () => {
    const election = await closedElection();
    await tallyElection(t, election.id);
    const status = await t.prisma.election.findUniqueOrThrow({ where: { id: election.id } });
    expect(status.status).toBe('TALLIED');
    const events = await t.prisma.auditEvent.findMany({
      orderBy: { seq: 'asc' },
      select: { eventType: true },
    });
    expect(events.slice(-2).map((e) => e.eventType)).toEqual(['TALLY_STARTED', 'TALLY_COMPLETED']);
  });

  it('refuses before the election is CLOSED (409)', async () => {
    const { election } = await createElectionWithTokens(t, clock);
    expect((await tallyElection(t, election.id)).statusCode).toBe(409);
  });

  it('tallies exactly once, even under concurrent requests', async () => {
    const election = await closedElection();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => tallyElection(t, election.id)),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(9);
    expect(await t.prisma.tallyResult.count()).toBe(1);
  });

  it('is admin-only', async () => {
    const election = await closedElection();
    const response = await t.app.inject({
      method: 'POST',
      url: `/admin/elections/${election.id}/tally`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('publication', () => {
  it('publishes nothing before the tally — no partial results', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    await castBallot(t, { token: tokens[0] ?? '', electionId: election.id });
    for (const path of ['tally', 'ballots']) {
      const open = await t.app.inject({ method: 'GET', url: `/elections/${election.id}/${path}` });
      expect(open.statusCode).toBe(409);
    }
    await closeElection(t, clock, election);
    for (const path of ['tally', 'ballots']) {
      const closed = await t.app.inject({
        method: 'GET',
        url: `/elections/${election.id}/${path}`,
      });
      expect(closed.statusCode).toBe(409);
    }
  });

  it('lists ballots in commitment order, never in arrival order, without voter data', async () => {
    const election = await closedElection();
    await tallyElection(t, election.id);
    const { ballots } = await getPublished(election.id);
    const commitments = ballots.ballots.map((b) => b.commitment);
    expect(commitments).toEqual([...commitments].sort());
    for (const ballot of ballots.ballots) {
      expect(Object.keys(ballot).sort()).toEqual(['candidateId', 'commitment', 'id', 'kind']);
    }
  });
});

describe('independent verification of the published result', () => {
  it('verifies signatures, commitments, Merkle root and the recount', async () => {
    const election = await closedElection();
    await tallyElection(t, election.id);
    const { tally, ballots } = await getPublished(election.id);
    const report = await verifyPublishedResult(tally, ballots);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it.each([
    [
      'inflated votes in the result',
      (p: { tally: PublishedTally; ballots: PublishedBallots }) => {
        const first = p.tally.result.candidates[0];
        if (first) first.votes += 1;
      },
    ],
    [
      'a ballot switched to another kind',
      (p: { tally: PublishedTally; ballots: PublishedBallots }) => {
        const ballot = p.ballots.ballots.find((b) => b.kind === 'BLANK');
        if (ballot) ballot.kind = 'NULL_VOTE';
      },
    ],
    [
      'a ballot removed',
      (p: { tally: PublishedTally; ballots: PublishedBallots }) => {
        p.ballots.ballots.pop();
      },
    ],
    [
      'a forged seal root',
      (p: { tally: PublishedTally; ballots: PublishedBallots }) => {
        p.tally.seal.merkleRoot = '00'.repeat(32);
      },
    ],
    [
      'a forged signature',
      (p: { tally: PublishedTally; ballots: PublishedBallots }) => {
        p.tally.signature = p.tally.seal.signature;
      },
    ],
  ])('detects %s', async (_label, tamper) => {
    const election = await closedElection();
    await tallyElection(t, election.id);
    const published = await getPublished(election.id);
    tamper(published);
    expect((await verifyPublishedResult(published.tally, published.ballots)).valid).toBe(false);
  });
});

describe('seal', () => {
  it('BALLOT_BOX_SEALED carries the Merkle root, an audit checkpoint and a signature', async () => {
    const election = await closedElection();
    const response = await t.app.inject({
      method: 'GET',
      url: `/admin/audit?electionId=${election.id}&limit=500`,
      headers: adminHeaders,
    });
    const sealed = response
      .json<{ events: { eventType: string; payload: Record<string, unknown> }[] }>()
      .events.find((e) => e.eventType === 'BALLOT_BOX_SEALED');
    expect(sealed?.payload).toMatchObject({
      ballots: 6,
      merkleRoot: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      auditHeadHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      signature: expect.any(String) as unknown,
    });
  });
});
