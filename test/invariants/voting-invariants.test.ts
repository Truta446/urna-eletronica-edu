import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inspectDatabaseError, SqlState } from '../../src/database/errors.js';
import { resetDatabase } from '../helpers/database.js';
import {
  authorizeVoter,
  castBallot,
  createElectionWithTokens,
  createVotingElection,
} from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * Invariantes centrais do sistema, provadas contra o PostgreSQL real.
 * INV-4 (apuração) e INV-5 (auditoria) chegam nas fases 7 e 6.
 */
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

describe('INV-1: a voter cannot vote twice', () => {
  it('a voter who already voted cannot be authorized again', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    const cpf = cpfs[0] ?? '';
    const { token } = (await authorizeVoter(t, election.id, cpf)).json<{ token: string }>();
    expect((await castBallot(t, { token, electionId: election.id })).statusCode).toBe(201);

    expect((await authorizeVoter(t, election.id, cpf)).statusCode).toBe(409);
    expect(await t.prisma.ballot.count()).toBe(1);
  });

  it('ballots never exceed authorized voters, even with concurrent authorizations', async () => {
    const { election, cpfs } = await createVotingElection(t, clock, { voters: 10 });
    // Cada eleitor tenta ser habilitado 3 vezes em paralelo e votar com tudo que receber.
    const attempts = await Promise.all(
      cpfs.flatMap((cpf) => [1, 2, 3].map(() => authorizeVoter(t, election.id, cpf))),
    );
    const tokens = attempts
      .filter((r) => r.statusCode === 201)
      .map((r) => r.json<{ token: string }>().token);
    await Promise.all(tokens.map((token) => castBallot(t, { token, electionId: election.id })));

    expect(tokens).toHaveLength(10);
    expect(await t.prisma.ballot.count()).toBe(10);
    expect(await t.prisma.voter.count({ where: { hasVoted: true } })).toBe(10);
  });
});

describe('INV-2: one authorization yields at most one ballot', () => {
  it('a token cannot be used twice through the API', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    const token = tokens[0] ?? '';
    expect((await castBallot(t, { token, electionId: election.id })).statusCode).toBe(201);
    expect((await castBallot(t, { token, electionId: election.id })).statusCode).toBe(409);
    expect(await t.prisma.ballot.count()).toBe(1);
  });

  it('the database rejects a second ballot with the same nullifier', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    await castBallot(t, { token: tokens[0] ?? '', electionId: election.id });
    const existing = await t.prisma.ballot.findFirstOrThrow();

    try {
      await t.prisma.ballot.create({
        data: {
          id: randomUUID(),
          electionId: election.id,
          kind: 'BLANK',
          nullifier: existing.nullifier,
          commitment: randomBytes(32),
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(inspectDatabaseError(error)?.sqlState).toBe(SqlState.UNIQUE_VIOLATION);
    }
  });

  it('the database rejects a ballot that did not consume a session (ballot stuffing)', async () => {
    const { election } = await createElectionWithTokens(t, clock);
    try {
      await t.prisma.ballot.create({
        data: {
          id: randomUUID(),
          electionId: election.id,
          kind: 'BLANK',
          nullifier: randomBytes(32),
          commitment: randomBytes(32),
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(inspectDatabaseError(error)?.sqlState).toBe(SqlState.BALLOT_UNBALANCED);
    }
    expect(await t.prisma.ballot.count()).toBe(0);
  });
});

describe('INV-3: no ballot has a voterId', () => {
  it('the ballots table has no column referring to voters, sessions or time', async () => {
    const columns = await t.prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ballots'`;
    const names = columns.map((c) => c.column_name).sort();

    expect(names).toEqual([
      'candidate_id',
      'ciphertext',
      'commitment',
      'election_id',
      'encapsulated_key',
      'id',
      'kind',
      'nullifier',
    ]);
    for (const { column_name, data_type } of columns) {
      expect(column_name).not.toMatch(/voter|session|token|created|time|_at$/);
      expect(data_type).not.toMatch(/timestamp|date|time/);
    }
  });

  it('no foreign key links ballots to voters or voting_sessions', async () => {
    const references = await t.prisma.$queryRaw<{ referenced: string }[]>`
      SELECT confrelid::regclass::text AS referenced
        FROM pg_constraint
       WHERE contype = 'f' AND conrelid = 'ballots'::regclass`;
    expect(references.map((r) => r.referenced).sort()).toEqual(['candidates', 'elections']);
  });

  it('no table links voters to voting_sessions or ballots by foreign key', async () => {
    const links = await t.prisma.$queryRaw<{ source: string; target: string }[]>`
      SELECT conrelid::regclass::text AS source, confrelid::regclass::text AS target
        FROM pg_constraint
       WHERE contype = 'f'
         AND (conrelid::regclass::text, confrelid::regclass::text) IN (
           ('voting_sessions', 'voters'), ('ballots', 'voters'),
           ('ballots', 'voting_sessions'), ('voters', 'voting_sessions'), ('voters', 'ballots'))`;
    expect(links).toEqual([]);
  });
});

describe('INV-6: retries do not create duplicate ballots', () => {
  it('100 sequential retries with the same Idempotency-Key replay the original response', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    const options = {
      token: tokens[0] ?? '',
      electionId: election.id,
      idempotencyKey: randomUUID(),
      choice: { type: 'candidate', number: 10 } as const,
    };
    const first = await castBallot(t, options);
    expect(first.statusCode).toBe(201);

    for (let i = 0; i < 100; i++) {
      const retry = await castBallot(t, options);
      expect(retry.statusCode).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toBe(first.body);
    }
    expect(await t.prisma.ballot.count()).toBe(1);
  });

  it('the same Idempotency-Key with a different choice is rejected (422), not re-voted', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    const base = { token: tokens[0] ?? '', electionId: election.id, idempotencyKey: randomUUID() };
    expect((await castBallot(t, { ...base, choice: { type: 'blank' } })).statusCode).toBe(201);
    expect((await castBallot(t, { ...base, choice: { type: 'null' } })).statusCode).toBe(422);
    expect((await t.prisma.ballot.findFirstOrThrow()).kind).toBe('BLANK');
  });

  it('concurrent retries with the same key: all succeed, one ballot', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    const options = {
      token: tokens[0] ?? '',
      electionId: election.id,
      idempotencyKey: randomUUID(),
    };
    const responses = await Promise.all(Array.from({ length: 30 }, () => castBallot(t, options)));

    expect(responses.map((r) => r.statusCode)).toEqual(responses.map(() => 201));
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'false')).toHaveLength(1);
    expect(await t.prisma.ballot.count()).toBe(1);
  });
});

describe('INV-7: concurrent requests with the same token produce exactly one ballot', () => {
  it('50 concurrent requests with different Idempotency-Keys and choices', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    const token = tokens[0] ?? '';
    const choices = [
      { type: 'blank' },
      { type: 'null' },
      { type: 'candidate', number: 10 },
    ] as const;

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        castBallot(t, { token, electionId: election.id, choice: choices[i % 3] ?? choices[0] }),
      ),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(49);
    expect(await t.prisma.ballot.count()).toBe(1);
    expect(await t.prisma.votingSession.count({ where: { consumed: true } })).toBe(1);
  });

  it('many voters voting at once: ballots == tokens used, no 5xx', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 40 });
    const responses = await Promise.all(
      tokens.map((token) => castBallot(t, { token, electionId: election.id })),
    );
    expect(responses.map((r) => r.statusCode)).toEqual(tokens.map(() => 201));
    expect(await t.prisma.ballot.count()).toBe(40);
  });
});

describe('balance counters (O(1) balances)', () => {
  it('match the real counts after concurrent authorizations and votes', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 30 });
    await Promise.all(
      tokens.slice(0, 20).map((token) => castBallot(t, { token, electionId: election.id })),
    );

    const [counters] = await t.prisma.$queryRaw<
      { authorized: bigint; sessions: bigint; consumed: bigint; ballots: bigint }[]
    >`
      SELECT (SELECT sum(authorized_voters) FROM authorization_counters WHERE election_id = e.id)::bigint AS authorized,
             (SELECT sum(sessions) FROM authorization_counters WHERE election_id = e.id)::bigint AS sessions,
             (SELECT sum(consumed_sessions) FROM ballot_counters WHERE election_id = e.id)::bigint AS consumed,
             (SELECT sum(ballots) FROM ballot_counters WHERE election_id = e.id)::bigint AS ballots
        FROM elections e WHERE e.id = ${election.id}::uuid`;
    expect(counters).toEqual({ authorized: 30n, sessions: 30n, consumed: 20n, ballots: 20n });
    // 16 shards por eleição, e a carga se espalhou por mais de um.
    const used = await t.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM ballot_counters WHERE election_id = ${election.id}::uuid AND ballots > 0`;
    expect(Number(used[0]?.n)).toBeGreaterThan(1);
    expect(await t.prisma.ballotCounters.count({ where: { electionId: election.id } })).toBe(16);
    expect(await t.prisma.voter.count({ where: { hasVoted: true } })).toBe(30);
    expect(await t.prisma.ballot.count()).toBe(20);
  });
});
