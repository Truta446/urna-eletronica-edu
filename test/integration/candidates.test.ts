import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/database.js';
import { addCandidate, createElection, openElection } from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const clock = createFakeClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(() => resetDatabase(t.prisma));
afterAll(() => t.close());

const listCandidates = (electionId: string) =>
  t.app.inject({ method: 'GET', url: `/elections/${electionId}/candidates` });

describe('POST /admin/elections/:id/candidates', () => {
  it('creates a candidate', async () => {
    const election = await createElection(t, clock.now());
    const response = await addCandidate(t, election.id, { number: 42, name: 'Fulana' });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: expect.any(String) as unknown,
      electionId: election.id,
      number: 42,
      name: 'Fulana',
    });
  });

  it('rejects a duplicate number in the same election (409)', async () => {
    const election = await createElection(t, clock.now());
    await addCandidate(t, election.id, { number: 42, name: 'Fulana' });
    const response = await addCandidate(t, election.id, { number: 42, name: 'Beltrana' });
    expect(response.statusCode).toBe(409);
  });

  it('allows the same number in different elections', async () => {
    const a = await createElection(t, clock.now());
    const b = await createElection(t, clock.now());
    expect((await addCandidate(t, a.id, { number: 42, name: 'X' })).statusCode).toBe(201);
    expect((await addCandidate(t, b.id, { number: 42, name: 'Y' })).statusCode).toBe(201);
  });

  it('refuses new candidates once the election is OPEN (409)', async () => {
    const election = await createElection(t, clock.now());
    await addCandidate(t, election.id, { number: 1, name: 'A' });
    await openElection(t, election.id);
    const response = await addCandidate(t, election.id, { number: 2, name: 'B' });
    expect(response.statusCode).toBe(409);
  });

  it('returns 404 for an unknown election', async () => {
    const response = await addCandidate(t, randomUUID(), { number: 1, name: 'A' });
    expect(response.statusCode).toBe(404);
  });

  it.each([
    ['zero', { number: 0, name: 'A' }],
    ['negative', { number: -1, name: 'A' }],
    ['six digits', { number: 100_000, name: 'A' }],
    ['float', { number: 4.2, name: 'A' }],
    ['numeric string', { number: '42', name: 'A' }],
    ['missing name', { number: 42 }],
    ['unknown field', { number: 42, name: 'A', electionId: randomUUID() }],
  ])('rejects %s with 400', async (_label, payload) => {
    const election = await createElection(t, clock.now());
    const response = await addCandidate(
      t,
      election.id,
      payload as { number: number; name: string },
    );
    expect(response.statusCode).toBe(400);
  });

  it('accepts exactly one of 20 concurrent inserts with the same number', async () => {
    const election = await createElection(t, clock.now());
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        addCandidate(t, election.id, { number: 7, name: `C${i}` }),
      ),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(19);
  });

  it('never leaves a candidate added after opening, even when racing the open', async () => {
    const election = await createElection(t, clock.now());
    await addCandidate(t, election.id, { number: 1, name: 'Seed' });

    const inserts = Array.from({ length: 30 }, (_, i) =>
      addCandidate(t, election.id, { number: 100 + i, name: `Late ${i}` }),
    );
    const [openResponse, ...insertResponses] = await Promise.all([
      openElection(t, election.id),
      ...inserts,
    ]);

    expect(openResponse.statusCode).toBe(200);
    // Toda resposta é 201 ou 409: nenhuma corrida vira 500.
    for (const r of insertResponses) expect([201, 409]).toContain(r.statusCode);

    const accepted = insertResponses.filter((r) => r.statusCode === 201).length;
    const stored = await t.prisma.candidate.count({ where: { electionId: election.id } });
    expect(stored).toBe(accepted + 1);
  });
});

describe('GET /elections/:id/candidates', () => {
  it('lists candidates ordered by number, publicly', async () => {
    const election = await createElection(t, clock.now());
    for (const number of [30, 10, 20])
      await addCandidate(t, election.id, { number, name: `N${number}` });

    const response = await listCandidates(election.id);
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ candidates: { number: number }[] }>().candidates.map((c) => c.number),
    ).toEqual([10, 20, 30]);
  });

  it('returns 404 for an unknown election', async () => {
    expect((await listCandidates(randomUUID())).statusCode).toBe(404);
  });
});
