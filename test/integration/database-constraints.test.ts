import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inspectDatabaseError, SqlState } from '../../src/database/errors.js';
import { canTransition, type ElectionStatus } from '../../src/modules/election/domain/election.js';
import { resetDatabase } from '../helpers/database.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * Manipulação direta do banco, ignorando a API: as invariantes precisam valer mesmo para
 * quem tem acesso SQL com a role da aplicação.
 */
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(() => resetDatabase(t.prisma));
afterAll(() => t.close());

const future = (hours: number) => new Date(Date.now() + hours * 3_600_000);

async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return inspectDatabaseError(error)?.sqlState ?? 'unknown';
  }
}

async function insertElection(status: ElectionStatus = 'DRAFT') {
  const election = await t.prisma.election.create({
    data: { name: 'E', startsAt: future(1), endsAt: future(2) },
  });
  // Avança pelo caminho legal até o status desejado.
  const path: ElectionStatus[] = ['OPEN', 'CLOSED', 'TALLIED'];
  for (const next of path.slice(0, path.indexOf(status) + 1)) {
    if (next === 'OPEN') {
      await t.prisma.candidate.create({ data: { electionId: election.id, number: 1, name: 'C' } });
    }
    await t.prisma.election.update({ where: { id: election.id }, data: { status: next } });
  }
  return election;
}

describe('elections table', () => {
  it('CHECK rejects ends_at <= starts_at', async () => {
    const state = await sqlStateOf(
      t.prisma.election.create({ data: { name: 'E', startsAt: future(2), endsAt: future(1) } }),
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });

  it('CHECK rejects blank names', async () => {
    const state = await sqlStateOf(
      t.prisma.election.create({ data: { name: '   ', startsAt: future(1), endsAt: future(2) } }),
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });

  it('trigger rejects creating an election directly as OPEN', async () => {
    const state = await sqlStateOf(
      t.prisma.election.create({
        data: { name: 'E', status: 'OPEN', startsAt: future(1), endsAt: future(2) },
      }),
    );
    expect(state).toBe(SqlState.INVALID_ELECTION_TRANSITION);
  });

  const statuses: ElectionStatus[] = ['DRAFT', 'OPEN', 'CLOSED', 'TALLIED'];
  for (const from of statuses) {
    for (const to of statuses.filter((s) => s !== from)) {
      const expected = canTransition(from, to) ? 'allows' : 'rejects';
      it(`trigger ${expected} ${from} -> ${to} (agrees with the domain)`, async () => {
        const election = await insertElection(from);
        const state = await sqlStateOf(
          t.prisma.election.update({ where: { id: election.id }, data: { status: to } }),
        );
        expect(state).toBe(
          canTransition(from, to) ? undefined : SqlState.INVALID_ELECTION_TRANSITION,
        );
      });
    }
  }

  it('allows editing name and schedule while DRAFT', async () => {
    const election = await insertElection('DRAFT');
    const state = await sqlStateOf(
      t.prisma.election.update({ where: { id: election.id }, data: { name: 'Renamed' } }),
    );
    expect(state).toBeUndefined();
  });

  it.each([
    ['name', { name: 'Hijacked' }],
    ['starts_at', { startsAt: future(1.5) }],
    ['ends_at', { endsAt: future(48) }],
  ])('freezes %s after DRAFT', async (_label, data) => {
    const election = await insertElection('OPEN');
    const state = await sqlStateOf(t.prisma.election.update({ where: { id: election.id }, data }));
    expect(state).toBe(SqlState.ELECTION_FROZEN);
  });

  it('rejects deleting a non-DRAFT election', async () => {
    const election = await insertElection('OPEN');
    const state = await sqlStateOf(
      t.prisma.$executeRaw`DELETE FROM elections WHERE id = ${election.id}::uuid`,
    );
    expect(state).toBe(SqlState.ELECTION_FROZEN);
  });
});

describe('candidates table', () => {
  it('UNIQUE rejects duplicate numbers per election', async () => {
    const election = await insertElection();
    await t.prisma.candidate.create({ data: { electionId: election.id, number: 5, name: 'A' } });
    const state = await sqlStateOf(
      t.prisma.candidate.create({ data: { electionId: election.id, number: 5, name: 'B' } }),
    );
    expect(state).toBe(SqlState.UNIQUE_VIOLATION);
  });

  it.each([0, -1, 100_000])('CHECK rejects number %i', async (number) => {
    const election = await insertElection();
    const state = await sqlStateOf(
      t.prisma.candidate.create({ data: { electionId: election.id, number, name: 'A' } }),
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });

  it('trigger rejects inserting into an OPEN election', async () => {
    const election = await insertElection('OPEN');
    const state = await sqlStateOf(
      t.prisma.candidate.create({ data: { electionId: election.id, number: 2, name: 'Late' } }),
    );
    expect(state).toBe(SqlState.ELECTION_NOT_DRAFT);
  });

  it('trigger rejects renaming or renumbering after DRAFT', async () => {
    const election = await insertElection('OPEN');
    const state = await sqlStateOf(
      t.prisma.candidate.updateMany({ where: { electionId: election.id }, data: { number: 99 } }),
    );
    expect(state).toBe(SqlState.ELECTION_NOT_DRAFT);
  });

  it('trigger rejects deleting candidates after DRAFT', async () => {
    const election = await insertElection('OPEN');
    const state = await sqlStateOf(
      t.prisma.candidate.deleteMany({ where: { electionId: election.id } }),
    );
    expect(state).toBe(SqlState.ELECTION_NOT_DRAFT);
  });

  it('trigger rejects moving a candidate to another election', async () => {
    const a = await insertElection();
    const b = await insertElection();
    const candidate = await t.prisma.candidate.create({
      data: { electionId: a.id, number: 3, name: 'A' },
    });
    const state = await sqlStateOf(
      t.prisma.candidate.update({ where: { id: candidate.id }, data: { electionId: b.id } }),
    );
    expect(state).toBe(SqlState.ELECTION_NOT_DRAFT);
  });
});

describe('voters table', () => {
  const hmac = () => randomBytes(32);

  async function voterIn(status: ElectionStatus) {
    const election = await insertElection('DRAFT');
    const voter = await t.prisma.voter.create({
      data: { electionId: election.id, identifierHmac: hmac() },
    });
    if (status !== 'DRAFT') {
      await t.prisma.election.update({ where: { id: election.id }, data: { status: 'OPEN' } });
    }
    return { election, voter };
  }

  it('CHECK rejects identifiers that are not 32 bytes (e.g. a plaintext CPF)', async () => {
    const election = await insertElection();
    const state = await sqlStateOf(
      t.prisma.voter.create({
        data: { electionId: election.id, identifierHmac: Buffer.from('52998224725') },
      }),
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });

  it('UNIQUE rejects the same identifier twice in an election', async () => {
    const election = await insertElection();
    const identifierHmac = hmac();
    await t.prisma.voter.create({ data: { electionId: election.id, identifierHmac } });
    const state = await sqlStateOf(
      t.prisma.voter.create({ data: { electionId: election.id, identifierHmac } }),
    );
    expect(state).toBe(SqlState.UNIQUE_VIOLATION);
  });

  it('trigger rejects registering into an OPEN election', async () => {
    const election = await insertElection('OPEN');
    const state = await sqlStateOf(
      t.prisma.voter.create({ data: { electionId: election.id, identifierHmac: hmac() } }),
    );
    expect(state).toBe(SqlState.ELECTION_NOT_DRAFT);
  });

  it('trigger rejects registering a voter as already voted', async () => {
    const election = await insertElection();
    const state = await sqlStateOf(
      t.prisma.voter.create({
        data: { electionId: election.id, identifierHmac: hmac(), hasVoted: true },
      }),
    );
    expect(state).toBe(SqlState.VOTER_IMMUTABLE);
  });

  it('trigger rejects deleting voters after DRAFT', async () => {
    const { voter } = await voterIn('OPEN');
    const state = await sqlStateOf(t.prisma.voter.delete({ where: { id: voter.id } }));
    expect(state).toBe(SqlState.ELECTION_NOT_DRAFT);
  });

  it('trigger rejects swapping the identifier hash', async () => {
    const { voter } = await voterIn('DRAFT');
    const state = await sqlStateOf(
      t.prisma.voter.update({ where: { id: voter.id }, data: { identifierHmac: hmac() } }),
    );
    expect(state).toBe(SqlState.VOTER_IMMUTABLE);
  });

  it('trigger rejects marking has_voted while the election is DRAFT', async () => {
    const { voter } = await voterIn('DRAFT');
    const state = await sqlStateOf(
      t.prisma.voter.update({ where: { id: voter.id }, data: { hasVoted: true } }),
    );
    expect(state).toBe(SqlState.ELECTION_NOT_OPEN);
  });

  it('allows has_voted false -> true while OPEN, and never back', async () => {
    const { voter } = await voterIn('OPEN');
    expect(
      await sqlStateOf(
        t.prisma.voter.update({ where: { id: voter.id }, data: { hasVoted: true } }),
      ),
    ).toBeUndefined();
    expect(
      await sqlStateOf(
        t.prisma.voter.update({ where: { id: voter.id }, data: { hasVoted: false } }),
      ),
    ).toBe(SqlState.VOTER_IMMUTABLE);
  });

  it('trigger rejects marking has_voted after the election is CLOSED', async () => {
    const { election, voter } = await voterIn('OPEN');
    await t.prisma.election.update({ where: { id: election.id }, data: { status: 'CLOSED' } });
    const state = await sqlStateOf(
      t.prisma.voter.update({ where: { id: voter.id }, data: { hasVoted: true } }),
    );
    expect(state).toBe(SqlState.ELECTION_NOT_OPEN);
  });
});
