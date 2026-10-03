import { randomBytes, randomUUID } from 'node:crypto';
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

  it('allows has_voted false -> true while OPEN (paired with a session), and never back', async () => {
    const { election, voter } = await voterIn('OPEN');
    expect(
      await sqlStateOf(
        t.prisma.$transaction([
          t.prisma.voter.update({ where: { id: voter.id }, data: { hasVoted: true } }),
          t.prisma.votingSession.create({
            data: { electionId: election.id, tokenHash: hmac(), expiresAt: future(1) },
          }),
        ]),
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

describe('voting_sessions table', () => {
  const hash = () => randomBytes(32);
  const later = () => future(1);

  /** Habilitação legítima feita "à mão": marca eleitor e cria sessão na mesma transação. */
  async function authorizedSession() {
    const election = await insertElection('DRAFT');
    const voter = await t.prisma.voter.create({
      data: { electionId: election.id, identifierHmac: hash() },
    });
    await t.prisma.election.update({ where: { id: election.id }, data: { status: 'OPEN' } });
    const [, session] = await t.prisma.$transaction([
      t.prisma.voter.update({ where: { id: voter.id }, data: { hasVoted: true } }),
      t.prisma.votingSession.create({
        data: { electionId: election.id, tokenHash: hash(), expiresAt: later() },
      }),
    ]);
    return { election, voter, session };
  }

  it('accepts voter flag + session in the same transaction', async () => {
    const { session } = await authorizedSession();
    expect(session.consumed).toBe(false);
  });

  it('BALANCE: rejects a session created without authorizing a voter (ballot stuffing)', async () => {
    const { election } = await authorizedSession();
    const state = await sqlStateOf(
      t.prisma.votingSession.create({
        data: { electionId: election.id, tokenHash: hash(), expiresAt: later() },
      }),
    );
    expect(state).toBe(SqlState.AUTHORIZATION_UNBALANCED);
    expect(await t.prisma.votingSession.count()).toBe(1);
  });

  it('BALANCE: rejects authorizing a voter without creating a session', async () => {
    const election = await insertElection('DRAFT');
    const voter = await t.prisma.voter.create({
      data: { electionId: election.id, identifierHmac: hash() },
    });
    await t.prisma.election.update({ where: { id: election.id }, data: { status: 'OPEN' } });
    const state = await sqlStateOf(
      t.prisma.voter.update({ where: { id: voter.id }, data: { hasVoted: true } }),
    );
    expect(state).toBe(SqlState.AUTHORIZATION_UNBALANCED);
    expect((await t.prisma.voter.findUniqueOrThrow({ where: { id: voter.id } })).hasVoted).toBe(
      false,
    );
  });

  it('CHECK rejects a token hash that is not 32 bytes (e.g. a raw token)', async () => {
    const { election } = await authorizedSession();
    const state = await sqlStateOf(
      t.prisma.votingSession.create({
        data: { electionId: election.id, tokenHash: Buffer.from('raw-token'), expiresAt: later() },
      }),
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });

  it('UNIQUE rejects a repeated token hash', async () => {
    const { election, session } = await authorizedSession();
    const state = await sqlStateOf(
      t.prisma.votingSession.create({
        data: { electionId: election.id, tokenHash: session.tokenHash, expiresAt: later() },
      }),
    );
    expect(state).toBe(SqlState.UNIQUE_VIOLATION);
  });

  it('trigger rejects sessions in a DRAFT election', async () => {
    const election = await insertElection('DRAFT');
    const state = await sqlStateOf(
      t.prisma.votingSession.create({
        data: { electionId: election.id, tokenHash: hash(), expiresAt: later() },
      }),
    );
    expect(state).toBe(SqlState.ELECTION_NOT_OPEN);
  });

  it('trigger rejects sessions created already consumed', async () => {
    const election = await insertElection('OPEN');
    const state = await sqlStateOf(
      t.prisma.votingSession.create({
        data: { electionId: election.id, tokenHash: hash(), expiresAt: later(), consumed: true },
      }),
    );
    expect(state).toBe(SqlState.SESSION_IMMUTABLE);
  });

  it.each([
    ['token_hash', () => ({ tokenHash: randomBytes(32) })],
    ['expires_at (extending validity)', () => ({ expiresAt: future(100) })],
  ])('trigger rejects changing %s', async (_label, data) => {
    const { session } = await authorizedSession();
    const state = await sqlStateOf(
      t.prisma.votingSession.update({ where: { id: session.id }, data: data() }),
    );
    expect(state).toBe(SqlState.SESSION_IMMUTABLE);
  });

  it('allows consumed false -> true while OPEN (paired with a ballot), and never back', async () => {
    const { election, session } = await authorizedSession();
    const consumedWithBallot = sqlStateOf(
      t.prisma.$transaction([
        t.prisma.votingSession.update({ where: { id: session.id }, data: { consumed: true } }),
        t.prisma.ballot.create({
          data: {
            id: randomUUID(),
            electionId: election.id,
            kind: 'BLANK',
            nullifier: hash(),
            commitment: hash(),
          },
        }),
      ]),
    );
    expect(await consumedWithBallot).toBeUndefined();
    expect(
      await sqlStateOf(
        t.prisma.votingSession.update({ where: { id: session.id }, data: { consumed: false } }),
      ),
    ).toBe(SqlState.SESSION_IMMUTABLE);
  });

  it('trigger rejects consuming after the election is CLOSED', async () => {
    const { election, session } = await authorizedSession();
    await t.prisma.election.update({ where: { id: election.id }, data: { status: 'CLOSED' } });
    const state = await sqlStateOf(
      t.prisma.votingSession.update({ where: { id: session.id }, data: { consumed: true } }),
    );
    expect(state).toBe(SqlState.ELECTION_NOT_OPEN);
  });

  it('trigger rejects deleting sessions', async () => {
    const { session } = await authorizedSession();
    const state = await sqlStateOf(t.prisma.votingSession.delete({ where: { id: session.id } }));
    expect(state).toBe(SqlState.SESSION_IMMUTABLE);
  });
});

describe('ballots table', () => {
  const bytes = () => randomBytes(32);

  /** Monta o cenário legítimo pelo caminho legal: DRAFT -> eleitor -> OPEN -> habilita -> sessão. */
  async function readyToVote() {
    const election = await insertElection('DRAFT');
    const candidate = await t.prisma.candidate.create({
      data: { electionId: election.id, number: 7, name: 'C' },
    });
    const voter = await t.prisma.voter.create({
      data: { electionId: election.id, identifierHmac: bytes() },
    });
    await t.prisma.election.update({ where: { id: election.id }, data: { status: 'OPEN' } });
    const [, session] = await t.prisma.$transaction([
      t.prisma.voter.update({ where: { id: voter.id }, data: { hasVoted: true } }),
      t.prisma.votingSession.create({
        data: { electionId: election.id, tokenHash: bytes(), expiresAt: future(1) },
      }),
    ]);
    return { election, candidate, session };
  }

  /** Consome a sessão e insere o voto na mesma transação (o caminho legal). */
  function castDirect(
    electionId: string,
    sessionId: string,
    ballot: { kind: 'CANDIDATE' | 'BLANK' | 'NULL_VOTE'; candidateId?: string | null },
  ) {
    return t.prisma.$transaction([
      t.prisma.votingSession.update({ where: { id: sessionId }, data: { consumed: true } }),
      t.prisma.ballot.create({
        data: {
          id: randomUUID(),
          electionId,
          kind: ballot.kind,
          candidateId: ballot.candidateId ?? null,
          nullifier: bytes(),
          commitment: bytes(),
        },
      }),
    ]);
  }

  it('accepts consume + insert in the same transaction', async () => {
    const { election, candidate, session } = await readyToVote();
    expect(
      await sqlStateOf(
        castDirect(election.id, session.id, { kind: 'CANDIDATE', candidateId: candidate.id }),
      ),
    ).toBeUndefined();
  });

  it.each([
    ['CANDIDATE without candidate_id', { kind: 'CANDIDATE' as const, candidateId: null }],
    ['BLANK pointing to a candidate', { kind: 'BLANK' as const, candidateId: 'CANDIDATE' }],
  ])('CHECK rejects %s', async (_label, ballot) => {
    const { election, candidate, session } = await readyToVote();
    const candidateId = ballot.candidateId === 'CANDIDATE' ? candidate.id : null;
    const state = await sqlStateOf(
      castDirect(election.id, session.id, { kind: ballot.kind, candidateId }),
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });

  it('composite FK rejects a candidate from another election', async () => {
    const { election, session } = await readyToVote();
    const other = await insertElection('DRAFT');
    const foreign = await t.prisma.candidate.create({
      data: { electionId: other.id, number: 7, name: 'Outsider' },
    });
    const state = await sqlStateOf(
      castDirect(election.id, session.id, { kind: 'CANDIDATE', candidateId: foreign.id }),
    );
    expect(state).toBe('23503');
  });

  it('BALANCE: rejects consuming a session without storing a ballot', async () => {
    const { session } = await readyToVote();
    const state = await sqlStateOf(
      t.prisma.votingSession.update({ where: { id: session.id }, data: { consumed: true } }),
    );
    expect(state).toBe(SqlState.BALLOT_UNBALANCED);
  });

  it('trigger rejects updating a ballot (changing the vote)', async () => {
    const { election, candidate, session } = await readyToVote();
    await castDirect(election.id, session.id, { kind: 'CANDIDATE', candidateId: candidate.id });
    const state = await sqlStateOf(
      t.prisma.ballot.updateMany({ data: { kind: 'BLANK', candidateId: null } }),
    );
    expect(state).toBe(SqlState.BALLOT_IMMUTABLE);
  });

  it('trigger rejects deleting a ballot', async () => {
    const { election, session } = await readyToVote();
    await castDirect(election.id, session.id, { kind: 'BLANK' });
    expect(await sqlStateOf(t.prisma.ballot.deleteMany({}))).toBe(SqlState.BALLOT_IMMUTABLE);
    expect(await t.prisma.ballot.count()).toBe(1);
  });

  it('trigger rejects ballots after the election is CLOSED', async () => {
    const { election, session } = await readyToVote();
    await t.prisma.election.update({ where: { id: election.id }, data: { status: 'CLOSED' } });
    const state = await sqlStateOf(castDirect(election.id, session.id, { kind: 'BLANK' }));
    expect(state).toBe(SqlState.ELECTION_NOT_OPEN);
  });

  it.each([
    ['nullifier', { nullifier: Buffer.from('short') }],
    ['commitment', { commitment: Buffer.from('short') }],
  ])('CHECK rejects a %s that is not 32 bytes', async (_label, override) => {
    const { election, session } = await readyToVote();
    const state = await sqlStateOf(
      t.prisma.$transaction([
        t.prisma.votingSession.update({ where: { id: session.id }, data: { consumed: true } }),
        t.prisma.ballot.create({
          data: {
            id: randomUUID(),
            electionId: election.id,
            kind: 'BLANK',
            nullifier: bytes(),
            commitment: bytes(),
            ...override,
          },
        }),
      ]),
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });
});

describe('audit_events table', () => {
  const zero = Buffer.alloc(32);

  function insertEvent(seq: number, previousHash: Uint8Array<ArrayBuffer>) {
    return t.prisma.auditEvent.create({
      data: {
        seq,
        eventType: 'ELECTION_CREATED',
        actorType: 'ADMIN',
        actorIdentifier: 'direct-sql',
        payload: {},
        previousHash,
        eventHash: randomBytes(32),
        createdAt: new Date(),
      },
    });
  }

  it('accepts the genesis event pointing to 32 zero bytes', async () => {
    expect(await sqlStateOf(insertEvent(1, zero))).toBeUndefined();
  });

  it('rejects a first event that does not point to genesis', async () => {
    expect(await sqlStateOf(insertEvent(1, randomBytes(32)))).toBe(SqlState.AUDIT_CHAIN_BROKEN);
  });

  it('rejects an event whose previous_hash does not match its predecessor (fork)', async () => {
    await insertEvent(1, zero);
    expect(await sqlStateOf(insertEvent(2, randomBytes(32)))).toBe(SqlState.AUDIT_CHAIN_BROKEN);
  });

  it('rejects a gap in seq', async () => {
    const first = await insertEvent(1, zero);
    expect(await sqlStateOf(insertEvent(3, Buffer.from(first.eventHash)))).toBe(
      SqlState.AUDIT_CHAIN_BROKEN,
    );
  });

  it('rejects two events with the same seq (no forks)', async () => {
    const first = await insertEvent(1, zero);
    await insertEvent(2, Buffer.from(first.eventHash));
    expect(await sqlStateOf(insertEvent(2, Buffer.from(first.eventHash)))).toBe(
      SqlState.UNIQUE_VIOLATION,
    );
  });

  it('rejects UPDATE', async () => {
    await insertEvent(1, zero);
    expect(
      await sqlStateOf(t.prisma.auditEvent.updateMany({ data: { actorIdentifier: 'x' } })),
    ).toBe(SqlState.AUDIT_IMMUTABLE);
  });

  it('rejects DELETE', async () => {
    await insertEvent(1, zero);
    expect(await sqlStateOf(t.prisma.auditEvent.deleteMany({}))).toBe(SqlState.AUDIT_IMMUTABLE);
  });

  it('rejects TRUNCATE', async () => {
    await insertEvent(1, zero);
    expect(await sqlStateOf(t.prisma.$executeRawUnsafe('TRUNCATE audit_events'))).toBe(
      SqlState.AUDIT_IMMUTABLE,
    );
  });

  it('rejects a payload that is not a JSON object', async () => {
    const state = await sqlStateOf(
      t.prisma.$executeRaw`
        INSERT INTO audit_events (seq, event_type, actor_type, actor_identifier, payload,
                                  previous_hash, event_hash, created_at)
        VALUES (1, 'ELECTION_CREATED', 'ADMIN', 'x', '[1,2]'::jsonb, ${zero}, ${randomBytes(32)}, now())`,
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });
});

describe('encrypted ballots (v2) constraints', () => {
  it('freezes the encryption key after DRAFT', async () => {
    const election = await insertElection('OPEN');
    const state = await sqlStateOf(
      t.prisma.election.update({
        where: { id: election.id },
        data: { encryptionPublicKey: randomBytes(32) },
      }),
    );
    expect(state).toBe(SqlState.ELECTION_FROZEN);
  });

  it('CHECK rejects an encryption key that is not 32 bytes', async () => {
    const state = await sqlStateOf(
      t.prisma.election.create({
        data: {
          name: 'E',
          startsAt: future(1),
          endsAt: future(2),
          encryptionPublicKey: randomBytes(16),
        },
      }),
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });

  it('rejects a plaintext ballot in an encrypted election (UE013)', async () => {
    const election = await t.prisma.election.create({
      data: {
        name: 'E',
        startsAt: future(1),
        endsAt: future(2),
        encryptionPublicKey: randomBytes(32),
      },
    });
    await t.prisma.voter.create({
      data: { electionId: election.id, identifierHmac: randomBytes(32) },
    });
    await t.prisma.candidate.create({ data: { electionId: election.id, number: 1, name: 'C' } });
    await t.prisma.election.update({ where: { id: election.id }, data: { status: 'OPEN' } });
    const voter = await t.prisma.voter.findFirstOrThrow({ where: { electionId: election.id } });
    const session = await t.prisma.$transaction(async (tx) => {
      await tx.voter.update({ where: { id: voter.id }, data: { hasVoted: true } });
      return tx.votingSession.create({
        data: { electionId: election.id, tokenHash: randomBytes(32), expiresAt: future(1) },
      });
    });
    const state = await sqlStateOf(
      t.prisma.$transaction([
        t.prisma.votingSession.update({ where: { id: session.id }, data: { consumed: true } }),
        t.prisma.ballot.create({
          data: {
            id: randomUUID(),
            electionId: election.id,
            kind: 'BLANK',
            nullifier: randomBytes(32),
            commitment: randomBytes(32),
          },
        }),
      ]),
    );
    expect(state).toBe(SqlState.BALLOT_FORMAT_MISMATCH);
  });

  it.each([
    [
      'both kind and ciphertext',
      { kind: 'BLANK' as const, encapsulatedKey: randomBytes(32), ciphertext: randomBytes(33) },
    ],
    ['ciphertext without encapsulated key', { ciphertext: randomBytes(33) }],
    [
      'ciphertext of the wrong size',
      { encapsulatedKey: randomBytes(32), ciphertext: randomBytes(40) },
    ],
  ])('CHECK rejects %s', async (_label, data) => {
    const election = await insertElection('DRAFT');
    // Triggers desligados SÓ neste INSERT: o CHECK precisa ser a única barreira testada.
    const state = await sqlStateOf(
      t.prisma.$transaction([
        t.prisma.$executeRawUnsafe('ALTER TABLE ballots DISABLE TRIGGER ALL'),
        t.prisma.ballot.create({
          data: {
            id: randomUUID(),
            electionId: election.id,
            nullifier: randomBytes(32),
            commitment: randomBytes(32),
            ...data,
          },
        }),
        t.prisma.$executeRawUnsafe('ALTER TABLE ballots ENABLE TRIGGER ALL'),
      ]),
    );
    expect(state).toBe(SqlState.CHECK_VIOLATION);
  });
});
