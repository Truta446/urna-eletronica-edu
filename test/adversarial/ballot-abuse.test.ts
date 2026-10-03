import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateToken } from '../../src/security/tokens.js';
import { resetDatabase } from '../helpers/database.js';
import { castBallot, createElectionWithTokens } from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/** Tentativas de quebrar a urna pela API. Nenhuma pode gerar voto extra nem erro 5xx. */
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

describe('adversarial: ballot box', () => {
  it('300 concurrent requests with one token → exactly one ballot, zero 5xx', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    const responses = await Promise.all(
      Array.from({ length: 300 }, () =>
        castBallot(t, { token: tokens[0] ?? '', electionId: election.id }),
      ),
    );
    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500)).toEqual([]);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(await t.prisma.ballot.count()).toBe(1);
  });

  it('1000 random tokens → all 401, nothing consumed', async () => {
    const { election } = await createElectionWithTokens(t, clock);
    const responses = await Promise.all(
      Array.from({ length: 1000 }, () =>
        castBallot(t, { token: generateToken(), electionId: election.id }),
      ),
    );
    expect(new Set(responses.map((r) => r.statusCode))).toEqual(new Set([401]));
    expect(await t.prisma.ballot.count()).toBe(0);
    expect(await t.prisma.votingSession.count({ where: { consumed: true } })).toBe(0);
  });

  it('replaying a captured request with a different choice cannot change the vote', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    const captured = {
      token: tokens[0] ?? '',
      electionId: election.id,
      idempotencyKey: randomUUID(),
    };
    expect(
      (await castBallot(t, { ...captured, choice: { type: 'candidate', number: 10 } })).statusCode,
    ).toBe(201);

    const tampered = [
      await castBallot(t, { ...captured, choice: { type: 'candidate', number: 20 } }),
      await castBallot(t, {
        ...captured,
        idempotencyKey: randomUUID(),
        choice: { type: 'candidate', number: 20 },
      }),
    ];
    expect(tampered.map((r) => r.statusCode)).toEqual([422, 409]);

    const ballot = await t.prisma.ballot.findFirstOrThrow({ include: { candidate: true } });
    expect(ballot.candidate?.number).toBe(10);
  });

  it("an Idempotency-Key from one voter cannot replay another voter's response", async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 2 });
    const key = randomUUID();
    expect(
      (
        await castBallot(t, {
          token: tokens[0] ?? '',
          electionId: election.id,
          idempotencyKey: key,
        })
      ).statusCode,
    ).toBe(201);
    const second = await castBallot(t, {
      token: tokens[1] ?? '',
      electionId: election.id,
      idempotencyKey: key,
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('false');
    expect(await t.prisma.ballot.count()).toBe(2);
  });

  it.each([
    ['huge candidate number', { type: 'candidate', number: Number.MAX_SAFE_INTEGER }],
    ['negative number', { type: 'candidate', number: -10 }],
    ['NaN-like', { type: 'candidate', number: 'NaN' }],
    [
      'prototype pollution attempt',
      JSON.parse('{"type":"blank","__proto__":{"admin":true}}') as object,
    ],
    ['array instead of object', [{ type: 'blank' }]],
    ['null choice', null],
  ])('malformed choice (%s) → 400, token not consumed', async (_label, choice) => {
    const { election, tokens } = await createElectionWithTokens(t, clock);
    const response = await t.app.inject({
      method: 'POST',
      url: '/ballots',
      headers: { authorization: `Bearer ${tokens[0] ?? ''}`, 'idempotency-key': randomUUID() },
      payload: { electionId: election.id, choice },
    });
    expect(response.statusCode).toBe(400);
    expect(await t.prisma.votingSession.count({ where: { consumed: true } })).toBe(0);
  });

  it('non-existent election id with a valid token → 422, token not consumed', async () => {
    const { tokens } = await createElectionWithTokens(t, clock);
    const response = await castBallot(t, { token: tokens[0] ?? '', electionId: randomUUID() });
    expect(response.statusCode).toBe(422);
    expect(await t.prisma.votingSession.count({ where: { consumed: true } })).toBe(0);
  });
});
