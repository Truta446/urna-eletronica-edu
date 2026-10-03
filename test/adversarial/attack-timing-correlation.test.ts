import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/database.js';
import { authorizeVoter, castBallot, createVotingElection } from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTestApp, VOTING_SESSION_TTL_SECONDS, type TestApp } from '../helpers/test-app.js';

/**
 * ATAQUE A2 (Fase 10): correlação EXATA por horário entre auditoria e sessões.
 *
 * VOTER_AUTHORIZED.created_at era o instante exato da habilitação, e voting_sessions.expires_at
 * era esse mesmo instante + TTL. Um JOIN exato ligava "habilitado pelo mesário X às
 * 10:03:21.457" a uma sessão, que (mesma transação => mesmo xmin) leva ao voto, mesmo depois
 * do VACUUM apagar o vínculo eleitor <-> sessão.
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

/** Habilita e vota em instantes "humanos" (com segundos e milissegundos quebrados). */
async function voteAtIrregularTimes(voters: number) {
  const { election, cpfs } = await createVotingElection(t, clock, { voters });
  for (const [i, cpf] of cpfs.entries()) {
    clock.advance(37_000 + i * 1_337);
    const { token } = (await authorizeVoter(t, election.id, cpf)).json<{ token: string }>();
    await castBallot(t, { token, electionId: election.id });
  }
  return election;
}

describe('attack A2: exact time join between audit events and voting sessions', () => {
  it('REGRESSION: no session can be matched to an authorization event by exact time', async () => {
    await voteAtIrregularTimes(6);
    const matches = await t.prisma.$queryRaw<{ seq: number }[]>`
      SELECT a.seq
        FROM audit_events a
        JOIN voting_sessions s
          ON s.expires_at = a.created_at + make_interval(secs => ${VOTING_SESSION_TTL_SECONDS})
       WHERE a.event_type = 'VOTER_AUTHORIZED'`;
    expect(matches).toEqual([]);
  });

  it('expiry has minute granularity (seconds and milliseconds are zero)', async () => {
    await voteAtIrregularTimes(6);
    const sessions = await t.prisma.votingSession.findMany({ select: { expiresAt: true } });
    for (const { expiresAt } of sessions) {
      expect(expiresAt.getUTCSeconds()).toBe(0);
      expect(expiresAt.getUTCMilliseconds()).toBe(0);
    }
  });

  it('a token still lasts at least the configured TTL', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    clock.advance(12_345);
    const before = clock.now().getTime();
    const { expiresAt } = (await authorizeVoter(t, election.id, cpfs[0] ?? '')).json<{
      expiresAt: string;
    }>();
    const lifetime = new Date(expiresAt).getTime() - before;
    expect(lifetime).toBeGreaterThanOrEqual(VOTING_SESSION_TTL_SECONDS * 1000);
    expect(lifetime).toBeLessThan((VOTING_SESSION_TTL_SECONDS + 60) * 1000);
  });
});
