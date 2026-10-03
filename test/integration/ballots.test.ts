import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateToken } from '../../src/security/tokens.js';
import { resetDatabase } from '../helpers/database.js';
import { castBallot, createElectionWithTokens } from '../helpers/factories.js';
import { createFakeClock, HOUR } from '../helpers/fake-clock.js';
import {
  adminHeaders,
  createTestApp,
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

async function setup(voters = 1) {
  const { election, tokens } = await createElectionWithTokens(t, clock, { voters });
  return { electionId: election.id, endsAt: election.endsAt, token: tokens[0] ?? '', tokens };
}

describe('POST /ballots — happy path', () => {
  it.each([
    ['a candidate', { type: 'candidate', number: 10 } as const, 'CANDIDATE'],
    ['blank', { type: 'blank' } as const, 'BLANK'],
    ['null', { type: 'null' } as const, 'NULL_VOTE'],
  ])('accepts a vote for %s', async (_label, choice, kind) => {
    const { electionId, token } = await setup();
    const response = await castBallot(t, { token, electionId, choice });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ accepted: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['idempotent-replayed']).toBe('false');

    const ballot = await t.prisma.ballot.findFirstOrThrow();
    expect(ballot.kind).toBe(kind);
    expect(ballot.candidateId !== null).toBe(kind === 'CANDIDATE');
  });

  it('consumes the session in the same transaction', async () => {
    const { electionId, token } = await setup();
    await castBallot(t, { token, electionId });
    expect(await t.prisma.votingSession.count({ where: { consumed: true } })).toBe(1);
  });

  it('never returns a ballot id or a receipt (receipt-freeness)', async () => {
    const { electionId, token } = await setup();
    const response = await castBallot(t, { token, electionId });
    const ballot = await t.prisma.ballot.findFirstOrThrow();
    expect(response.body).not.toContain(ballot.id);
    expect(Object.keys(response.json<object>())).toEqual(['accepted']);
  });

  it('never logs the token or the choice', async () => {
    const { electionId, token } = await setup();
    t.logs.length = 0; // só os logs da chamada de voto
    await castBallot(t, { token, electionId, choice: { type: 'candidate', number: 20 } });
    const logs = JSON.stringify(t.logs);
    expect(logs).toContain('/ballots'); // garante que houve log a inspecionar
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('candidate');
  });
});

describe('POST /ballots — rejected without burning the token', () => {
  it('unknown candidate number → 422, and the token still works', async () => {
    const { electionId, token } = await setup();
    const bad = await castBallot(t, {
      token,
      electionId,
      choice: { type: 'candidate', number: 99 },
    });
    expect(bad.statusCode).toBe(422);
    expect(await t.prisma.ballot.count()).toBe(0);
    expect(await t.prisma.votingSession.count({ where: { consumed: true } })).toBe(0);

    const retry = await castBallot(t, {
      token,
      electionId,
      choice: { type: 'candidate', number: 10 },
    });
    expect(retry.statusCode).toBe(201);
  });

  it('token from another election → 422, and nothing is consumed', async () => {
    const a = await setup();
    clock.set(START);
    const b = await setup();
    const response = await castBallot(t, { token: a.token, electionId: b.electionId });
    expect(response.statusCode).toBe(422);
    expect(await t.prisma.votingSession.count({ where: { consumed: true } })).toBe(0);
  });
});

describe('POST /ballots — token errors', () => {
  it('reused token (new Idempotency-Key) → 409', async () => {
    const { electionId, token } = await setup();
    expect((await castBallot(t, { token, electionId })).statusCode).toBe(201);
    const again = await castBallot(t, { token, electionId, choice: { type: 'null' } });
    expect(again.statusCode).toBe(409);
    expect(await t.prisma.ballot.count()).toBe(1);
  });

  it('expired token → 401', async () => {
    const { electionId, token } = await setup();
    clock.advance(VOTING_SESSION_TTL_SECONDS * 1000);
    expect((await castBallot(t, { token, electionId })).statusCode).toBe(401);
    expect(await t.prisma.ballot.count()).toBe(0);
  });

  it('random well-formed token → 401', async () => {
    const { electionId } = await setup();
    expect((await castBallot(t, { token: generateToken(), electionId })).statusCode).toBe(401);
  });

  it.each([
    ['missing', undefined],
    ['wrong scheme', 'Basic abc'],
    ['malformed token', 'Bearer not-a-token'],
  ])('%s Authorization → 401 before reading the body', async (_label, authorization) => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/ballots',
      headers: {
        ...(authorization && { authorization }),
        'idempotency-key': randomUUID(),
        'content-type': 'application/json',
      },
      payload: '{"broken json',
    });
    expect(response.statusCode).toBe(401);
  });

  it('after the election is closed, leftover tokens are rejected and no ballot is stored', async () => {
    const { electionId, token, endsAt } = await setup();
    clock.set(new Date(new Date(endsAt).getTime() + HOUR));
    const close = await t.app.inject({
      method: 'POST',
      url: `/admin/elections/${electionId}/close`,
      headers: adminHeaders,
    });
    expect(close.statusCode).toBe(200);

    const response = await castBallot(t, { token, electionId });
    expect([401, 409]).toContain(response.statusCode);
    expect(await t.prisma.ballot.count()).toBe(0);
  });
});

describe('POST /ballots — validation', () => {
  it.each([
    ['missing choice', { electionId: randomUUID() }],
    ['unknown choice type', { electionId: randomUUID(), choice: { type: 'write-in', name: 'X' } }],
    ['candidate without number', { electionId: randomUUID(), choice: { type: 'candidate' } }],
    ['number as string', { electionId: randomUUID(), choice: { type: 'candidate', number: '10' } }],
    ['blank with extra field', { electionId: randomUUID(), choice: { type: 'blank', number: 10 } }],
    ['malformed electionId', { electionId: 'x', choice: { type: 'blank' } }],
    [
      'extra top-level field',
      { electionId: randomUUID(), choice: { type: 'blank' }, voterId: 'x' },
    ],
  ])('%s → 400', async (_label, payload) => {
    const { token } = await setup();
    const response = await t.app.inject({
      method: 'POST',
      url: '/ballots',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(await t.prisma.votingSession.count({ where: { consumed: true } })).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['too short', 'abc'],
    ['invalid characters', 'key with spaces and !!!'],
  ])('%s Idempotency-Key → 400', async (_label, key) => {
    const { token, electionId } = await setup();
    const response = await t.app.inject({
      method: 'POST',
      url: '/ballots',
      headers: { authorization: `Bearer ${token}`, ...(key && { 'idempotency-key': key }) },
      payload: { electionId, choice: { type: 'blank' } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('ballot storage', () => {
  it('stores exactly these columns — nothing that points to a voter, a session or a time', async () => {
    const { electionId, token } = await setup();
    await castBallot(t, { token, electionId });
    const rows = await t.prisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM ballots`;
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      [
        'candidate_id',
        'ciphertext',
        'commitment',
        'election_id',
        'encapsulated_key',
        'id',
        'kind',
        'nullifier',
      ].sort(),
    );
  });

  it('uses random (v4) ballot ids', async () => {
    const { electionId, tokens } = await setup(5);
    for (const token of tokens) await castBallot(t, { token, electionId });
    const ballots = await t.prisma.ballot.findMany({ select: { id: true } });
    for (const { id } of ballots) expect(id[14]).toBe('4');
  });

  it('closing the election purges idempotency records', async () => {
    const { electionId, token, endsAt } = await setup();
    await castBallot(t, { token, electionId });
    expect(await t.prisma.idempotencyRecord.count()).toBe(1);

    clock.set(new Date(endsAt));
    await t.app.inject({
      method: 'POST',
      url: `/admin/elections/${electionId}/close`,
      headers: adminHeaders,
    });
    expect(await t.prisma.idempotencyRecord.count()).toBe(0);
    expect(await t.prisma.ballot.count()).toBe(1);
  });
});
