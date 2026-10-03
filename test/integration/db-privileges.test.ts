import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../src/database/client.js';
import { inspectDatabaseError } from '../../src/database/errors.js';
import { resetDatabase } from '../helpers/database.js';
import { castBallot, closeElection, createElectionWithTokens } from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * Menor privilégio (Fase 9): com as credenciais da APLICAÇÃO, as operações perigosas são negadas
 * pelo próprio PostgreSQL (42501 insufficient_privilege), antes mesmo dos triggers.
 */
const INSUFFICIENT_PRIVILEGE = '42501';
const clock = createFakeClock();
let t: TestApp;
let asApp: PrismaClient;

beforeAll(async () => {
  t = await createTestApp({ clock });
  asApp = createPrismaClient(inject('databaseUrl'));
});
beforeEach(async () => {
  clock.set(new Date('2030-01-01T12:00:00Z'));
  await resetDatabase(t.prisma);
  const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 2 });
  await castBallot(t, { token: tokens[0] ?? '', electionId: election.id });
  await closeElection(t, clock, election);
});
afterAll(async () => {
  await asApp.$disconnect();
  await t.close();
});

async function sqlStateAsApp(sql: string): Promise<string | undefined> {
  try {
    await asApp.$executeRawUnsafe(sql);
    return undefined;
  } catch (error) {
    return inspectDatabaseError(error)?.sqlState ?? 'unknown';
  }
}

describe('the application role', () => {
  it('is urna_app and is NOT a superuser', async () => {
    const [me] = await asApp.$queryRaw<{ user: string; superuser: boolean }[]>`
      SELECT current_user AS user, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
    expect(me).toEqual({ user: 'urna_app', superuser: false });
  });

  it.each([
    ['change a vote', `UPDATE ballots SET kind = 'BLANK', candidate_id = NULL`],
    ['delete votes', 'DELETE FROM ballots'],
    ['truncate votes', 'TRUNCATE ballots'],
    ['rewrite the audit log', `UPDATE audit_events SET actor_identifier = 'x'`],
    ['delete audit events', 'DELETE FROM audit_events'],
    ['disable a trigger', 'ALTER TABLE ballots DISABLE TRIGGER ALL'],
    ['swap a voter identifier', `UPDATE voters SET identifier_hmac = identifier_hmac`],
    ['extend a token', `UPDATE voting_sessions SET expires_at = expires_at + interval '1 day'`],
    ['rename an election', `UPDATE elections SET name = 'x'`],
    ['delete an election', 'DELETE FROM elections'],
    ['rename a candidate', `UPDATE candidates SET name = 'x'`],
    ['alter a tally result', `UPDATE tally_results SET key_id = 'x'`],
    ['read migration history', 'SELECT * FROM _prisma_migrations'],
    ['create a table', 'CREATE TABLE evil (id int)'],
    ['fake the authorization balance', `UPDATE authorization_counters SET sessions = sessions + 1`],
    ['fake the ballot balance', `UPDATE ballot_counters SET ballots = ballots + 1`],
    ['insert counters', `INSERT INTO ballot_counters (election_id) SELECT gen_random_uuid()`],
  ])('cannot %s (42501)', async (_label, sql) => {
    expect(await sqlStateAsApp(sql)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('has no ballots/audit damage after all those attempts (control)', async () => {
    expect(await t.prisma.ballot.count()).toBe(1);
    expect(
      (await t.prisma.auditEvent.findFirstOrThrow({ where: { seq: 1 } })).actorIdentifier,
    ).toBe('test-admin');
  });
});
