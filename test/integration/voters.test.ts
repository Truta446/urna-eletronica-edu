import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomCpf } from '../helpers/cpf.js';
import { resetDatabase } from '../helpers/database.js';
import {
  createElection,
  createReadyElection,
  openElection,
  registerVoter,
} from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { adminHeaders, createTestApp, type TestApp } from '../helpers/test-app.js';

const clock = createFakeClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(() => resetDatabase(t.prisma));
afterAll(() => t.close());

const digits = (cpf: string) => cpf.replace(/\D/g, '');

describe('POST /admin/elections/:id/voters', () => {
  it('registers a voter and never echoes the identifier', async () => {
    const election = await createElection(t, clock.now());
    const cpf = randomCpf();
    const response = await registerVoter(t, election.id, cpf);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: expect.any(String) as unknown, electionId: election.id });
    expect(response.body).not.toContain(digits(cpf).slice(0, 9));
  });

  it('stores only a 32-byte HMAC — the CPF appears nowhere in the row', async () => {
    const election = await createElection(t, clock.now());
    const cpf = randomCpf();
    await registerVoter(t, election.id, cpf);

    const rows = await t.prisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM voters`;
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? {};
    expect(Object.keys(row).sort()).toEqual(
      ['created_at', 'election_id', 'has_voted', 'id', 'identifier_hmac'].sort(),
    );
    expect(row.identifier_hmac).toHaveLength(32);
    expect(row.has_voted).toBe(false);

    const dump = JSON.stringify(rows, (_k, v: unknown) =>
      v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v,
    );
    expect(dump).not.toContain(digits(cpf));
  });

  it('treats formatted and unformatted CPF as the same voter (409)', async () => {
    const election = await createElection(t, clock.now());
    const cpf = randomCpf();
    expect((await registerVoter(t, election.id, cpf)).statusCode).toBe(201);
    expect((await registerVoter(t, election.id, digits(cpf))).statusCode).toBe(409);
  });

  it('allows the same CPF in different elections, with unlinkable hashes', async () => {
    const a = await createElection(t, clock.now());
    const b = await createElection(t, clock.now());
    const cpf = randomCpf();
    expect((await registerVoter(t, a.id, cpf)).statusCode).toBe(201);
    expect((await registerVoter(t, b.id, cpf)).statusCode).toBe(201);

    const [first, second] = await t.prisma.voter.findMany({ select: { identifierHmac: true } });
    expect(first?.identifierHmac).not.toEqual(second?.identifierHmac);
  });

  it.each([
    ['invalid check digits', { voterIdentifier: '529.982.247-24' }],
    ['repeated digits', { voterIdentifier: '111.111.111-11' }],
    ['number instead of string', { voterIdentifier: 52998224725 }],
    ['oversized string', { voterIdentifier: '5'.repeat(10_000) }],
    ['missing field', {}],
    ['mass assignment of hasVoted', { voterIdentifier: '529.982.247-25', hasVoted: true }],
  ])('rejects %s with 400', async (_label, payload) => {
    const election = await createElection(t, clock.now());
    const response = await t.app.inject({
      method: 'POST',
      url: `/admin/elections/${election.id}/voters`,
      headers: adminHeaders,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(await t.prisma.voter.count()).toBe(0);
  });

  it('does not echo an invalid CPF in the response or the logs', async () => {
    const election = await createElection(t, clock.now());
    const invalid = '529.982.247-24';
    const response = await registerVoter(t, election.id, invalid);

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('529');
    expect(JSON.stringify(t.logs)).not.toContain('529982247');
  });

  it('refuses registration once the election is OPEN (409)', async () => {
    const election = await createReadyElection(t, clock.now());
    expect((await openElection(t, election.id)).statusCode).toBe(200);
    expect((await registerVoter(t, election.id)).statusCode).toBe(409);
  });

  it('returns 404 for an unknown election', async () => {
    expect((await registerVoter(t, randomUUID())).statusCode).toBe(404);
  });

  it('registers exactly once under 20 concurrent requests with the same CPF', async () => {
    const election = await createElection(t, clock.now());
    const cpf = randomCpf();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        registerVoter(t, election.id, i % 2 ? cpf : digits(cpf)),
      ),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(19);
    expect(await t.prisma.voter.count()).toBe(1);
  });
});
