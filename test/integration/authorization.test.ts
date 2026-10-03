import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken, TOKEN_PATTERN } from '../../src/security/tokens.js';
import { randomCpf } from '../helpers/cpf.js';
import { resetDatabase } from '../helpers/database.js';
import {
  authorizeVoter,
  createElection,
  createVotingElection,
  registerVoter,
} from '../helpers/factories.js';
import { createFakeClock, HOUR } from '../helpers/fake-clock.js';
import {
  adminHeaders,
  createTestApp,
  pollWorkerHeaders,
  VOTING_SESSION_TTL_SECONDS,
  type TestApp,
} from '../helpers/test-app.js';

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

interface Issued {
  token: string;
  expiresAt: string;
}

describe('POST /elections/:id/voting-sessions', () => {
  it('issues a single-use token and marks the voter', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    const response = await authorizeVoter(t, election.id, cpfs[0] ?? '');

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<Issued>();
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'token']);
    expect(body.token).toMatch(TOKEN_PATTERN);
    expect(new Date(body.expiresAt).getTime()).toBe(
      clock.now().getTime() + VOTING_SESSION_TTL_SECONDS * 1000,
    );

    const voter = await t.prisma.voter.findFirstOrThrow({ select: { hasVoted: true } });
    expect(voter.hasVoted).toBe(true);
  });

  it('stores the session WITHOUT voter id, timestamps of creation, or the raw token', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    const { token } = (await authorizeVoter(t, election.id, cpfs[0] ?? '')).json<Issued>();

    const rows = await t.prisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM voting_sessions`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'consumed',
      'election_id',
      'expires_at',
      'id',
      'token_hash',
    ]);
    expect(Buffer.from(rows[0]?.token_hash as Uint8Array)).toEqual(hashToken(token));
    expect(rows[0]?.consumed).toBe(false);
  });

  it('never persists the raw token in any table', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    const { token } = (await authorizeVoter(t, election.id, cpfs[0] ?? '')).json<Issued>();

    const tables = await t.prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    for (const { tablename } of tables) {
      const rows = await t.prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${tablename}"`);
      const dump = JSON.stringify(rows, (_k, v: unknown) => {
        if (v instanceof Uint8Array) return Buffer.from(v).toString('base64url');
        return typeof v === 'bigint' ? v.toString() : v;
      });
      expect(dump, tablename).not.toContain(token);
    }
  });

  it('never logs the token or the CPF', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    const cpf = cpfs[0] ?? '';
    const { token } = (await authorizeVoter(t, election.id, cpf)).json<Issued>();
    const logs = JSON.stringify(t.logs);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(cpf.replace(/\D/g, '').slice(0, 9));
  });

  it('caps expiry at the end of the voting window', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    clock.set(new Date(new Date(election.endsAt).getTime() - 60_000));
    const { expiresAt } = (await authorizeVoter(t, election.id, cpfs[0] ?? '')).json<Issued>();
    expect(expiresAt).toBe(election.endsAt);
  });

  it('refuses a second authorization for the same voter (409)', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    const cpf = cpfs[0] ?? '';
    expect((await authorizeVoter(t, election.id, cpf)).statusCode).toBe(201);
    const again = await authorizeVoter(t, election.id, cpf.replace(/\D/g, ''));
    expect(again.statusCode).toBe(409);
    expect(await t.prisma.votingSession.count()).toBe(1);
  });

  it('issues exactly one token under 25 concurrent authorizations of the same voter', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    const responses = await Promise.all(
      Array.from({ length: 25 }, () => authorizeVoter(t, election.id, cpfs[0] ?? '')),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(24);
    expect(await t.prisma.votingSession.count()).toBe(1);
  });

  it('keeps sessions == authorized voters under concurrent authorizations of different voters', async () => {
    const { election, cpfs } = await createVotingElection(t, clock, { voters: 30 });
    const responses = await Promise.all(cpfs.map((cpf) => authorizeVoter(t, election.id, cpf)));
    expect(responses.map((r) => r.statusCode)).toEqual(cpfs.map(() => 201));

    const tokens = new Set(responses.map((r) => r.json<Issued>().token));
    expect(tokens.size).toBe(30);
    expect(await t.prisma.votingSession.count()).toBe(30);
    expect(await t.prisma.voter.count({ where: { hasVoted: true } })).toBe(30);
  });

  it('returns 404 for a valid but unregistered CPF', async () => {
    const { election } = await createVotingElection(t, clock);
    expect((await authorizeVoter(t, election.id, randomCpf())).statusCode).toBe(404);
  });

  it('does not accept a voter registered in another election', async () => {
    const { cpfs } = await createVotingElection(t, clock);
    clock.set(START);
    const other = await createVotingElection(t, clock);
    const response = await authorizeVoter(t, other.election.id, cpfs[0] ?? '');
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for an invalid CPF', async () => {
    const { election } = await createVotingElection(t, clock);
    expect((await authorizeVoter(t, election.id, '529.982.247-24')).statusCode).toBe(400);
  });

  it('returns 404 for an unknown election', async () => {
    expect((await authorizeVoter(t, randomUUID(), randomCpf())).statusCode).toBe(404);
  });

  it('refuses while the election is DRAFT (409)', async () => {
    const election = await createElection(t, clock.now());
    const cpf = randomCpf();
    await registerVoter(t, election.id, cpf);
    clock.set(new Date(election.startsAt));
    expect((await authorizeVoter(t, election.id, cpf)).statusCode).toBe(409);
  });

  it('refuses before startsAt (409) and leaves the voter untouched', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    clock.set(new Date(new Date(election.startsAt).getTime() - 1));
    expect((await authorizeVoter(t, election.id, cpfs[0] ?? '')).statusCode).toBe(409);
    expect(await t.prisma.voter.count({ where: { hasVoted: true } })).toBe(0);
  });

  it('refuses at or after endsAt (409)', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    clock.set(new Date(election.endsAt));
    expect((await authorizeVoter(t, election.id, cpfs[0] ?? '')).statusCode).toBe(409);
  });

  it('refuses after the election is CLOSED (409)', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    clock.set(new Date(new Date(election.endsAt).getTime() + HOUR));
    const close = await t.app.inject({
      method: 'POST',
      url: `/admin/elections/${election.id}/close`,
      headers: adminHeaders,
    });
    expect(close.statusCode).toBe(200);
    expect((await authorizeVoter(t, election.id, cpfs[0] ?? '')).statusCode).toBe(409);
  });

  it('rejects mass assignment (e.g. choosing the token or expiry)', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    const response = await t.app.inject({
      method: 'POST',
      url: `/elections/${election.id}/voting-sessions`,
      headers: pollWorkerHeaders,
      payload: { voterIdentifier: cpfs[0], expiresAt: '2099-01-01T00:00:00Z' },
    });
    expect(response.statusCode).toBe(400);
  });
});
