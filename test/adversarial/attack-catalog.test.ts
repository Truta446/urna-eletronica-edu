import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/database.js';
import { authorizeVoter, castBallot, createVotingElection } from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import {
  ADMIN_TOKEN,
  POLL_WORKER_TOKEN,
  createTestApp,
  type TestApp,
} from '../helpers/test-app.js';

/**
 * Catálogo da Fase 10: tentativas que NÃO funcionam. Os demais ataques estão em
 * attack-*.test.ts, ballot-abuse.test.ts, known-risks.test.ts e nos testes de invariantes.
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

describe('tokens used in the wrong role', () => {
  it.each([
    ['an admin token', ADMIN_TOKEN],
    ['a poll worker token', POLL_WORKER_TOKEN],
  ])('%s cannot be used as a voting token', async (_label, token) => {
    const { election } = await createVotingElection(t, clock);
    expect((await castBallot(t, { token, electionId: election.id })).statusCode).toBe(401);
    expect(await t.prisma.ballot.count()).toBe(0);
  });

  it('a voting token cannot call admin or poll worker routes', async () => {
    const { election, cpfs } = await createVotingElection(t, clock, { voters: 2 });
    const { token } = (await authorizeVoter(t, election.id, cpfs[0] ?? '')).json<{
      token: string;
    }>();
    const headers = { authorization: `Bearer ${token}` };
    for (const url of [
      `/admin/elections/${election.id}/close`,
      `/elections/${election.id}/voting-sessions`,
    ]) {
      const response = await t.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { voterIdentifier: cpfs[1] },
      });
      expect(response.statusCode, url).toBe(401);
    }
  });
});

describe('correlation through public data', () => {
  it('nothing about voters, sessions or times is public before or after the tally', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    const { token } = (await authorizeVoter(t, election.id, cpfs[0] ?? '')).json<{
      token: string;
    }>();
    await castBallot(t, { token, electionId: election.id });
    const publicResponses = await Promise.all(
      ['', '/candidates', '/tally', '/ballots'].map((path) =>
        t.app.inject({ method: 'GET', url: `/elections/${election.id}${path}` }),
      ),
    );
    const body = publicResponses.map((r) => r.body).join('\n');
    const voter = await t.prisma.voter.findFirstOrThrow();
    const session = await t.prisma.votingSession.findFirstOrThrow();
    expect(body).not.toContain(voter.id);
    expect(body).not.toContain(session.id);
    expect(body).not.toContain(session.expiresAt.toISOString());
  });
});
