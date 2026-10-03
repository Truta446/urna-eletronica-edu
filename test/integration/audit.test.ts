import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/database.js';
import {
  addCandidate,
  authorizeVoter,
  castBallot,
  createElection,
  createElectionWithTokens,
  createVotingElection,
  registerVoter,
} from '../helpers/factories.js';
import { createFakeClock, HOUR } from '../helpers/fake-clock.js';
import {
  adminHeaders,
  createTestApp,
  pollWorkerHeaders,
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

interface EventBody {
  id: number;
  seq: number;
  eventType: string;
  actorType: string;
  actorIdentifier: string;
  electionId: string | null;
  payload: Record<string, unknown>;
}

async function listEvents(query = ''): Promise<EventBody[]> {
  const response = await t.app.inject({
    method: 'GET',
    url: `/admin/audit${query}`,
    headers: adminHeaders,
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ events: EventBody[] }>().events;
}

async function verify(query = '') {
  const response = await t.app.inject({
    method: 'GET',
    url: `/admin/audit/verify${query}`,
    headers: adminHeaders,
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    valid: boolean;
    eventCount: number;
    chains?: number;
    chain?: string;
    head?: { seq: number; hash: string } | null;
  }>();
}

describe('audit events', () => {
  it('records the whole administrative lifecycle with the right actors', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 2 });
    await castBallot(t, { token: tokens[0] ?? '', electionId: election.id });
    clock.set(new Date(new Date(election.endsAt).getTime() + HOUR));
    await t.app.inject({
      method: 'POST',
      url: `/admin/elections/${election.id}/close`,
      headers: adminHeaders,
    });

    const events = await listEvents();
    expect(events.map((e) => `${e.eventType}:${e.actorType}:${e.actorIdentifier}`)).toEqual([
      'ELECTION_CREATED:ADMIN:test-admin',
      'CANDIDATE_CREATED:ADMIN:test-admin',
      'CANDIDATE_CREATED:ADMIN:test-admin',
      'VOTER_REGISTERED:ADMIN:test-admin',
      'VOTER_REGISTERED:ADMIN:test-admin',
      'ELECTION_OPENED:ADMIN:test-admin',
      'VOTER_AUTHORIZED:POLL_WORKER:test-poll-worker',
      'VOTER_AUTHORIZED:POLL_WORKER:test-poll-worker',
      'ELECTION_CLOSED:ADMIN:test-admin',
      'BALLOT_BOX_SEALED:SYSTEM:urna-edu',
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it('BALLOT_BOX_SEALED records the final counts', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 3 });
    await castBallot(t, { token: tokens[0] ?? '', electionId: election.id });
    await castBallot(t, { token: tokens[1] ?? '', electionId: election.id });
    clock.set(new Date(election.endsAt));
    await t.app.inject({
      method: 'POST',
      url: `/admin/elections/${election.id}/close`,
      headers: adminHeaders,
    });

    const sealed = (await listEvents()).find((e) => e.eventType === 'BALLOT_BOX_SEALED');
    expect(sealed?.payload).toMatchObject({
      ballots: 2,
      consumedSessions: 2,
      authorizedVoters: 3,
      registeredVoters: 3,
      authorizedWithoutBallot: 1,
      idempotencyRecordsPurged: 2,
    });
  });

  it('records NO event per vote (avoids correlation by time)', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 3 });
    const before = (await listEvents()).length;
    for (const token of tokens) await castBallot(t, { token, electionId: election.id });
    expect(await listEvents()).toHaveLength(before);
  });

  it('VOTER_AUTHORIZED carries no voter information', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    await authorizeVoter(t, election.id, cpfs[0] ?? '');
    const authorized = (await listEvents()).find((e) => e.eventType === 'VOTER_AUTHORIZED');
    // Só nonce aleatório + assinatura do servidor (Fase 10, ataque A1). Nada do eleitor/sessão.
    expect(Object.keys(authorized?.payload ?? {}).sort()).toEqual(['keyId', 'nonce', 'signature']);
    const voter = await t.prisma.voter.findFirstOrThrow({ where: { hasVoted: true } });
    const session = await t.prisma.votingSession.findFirstOrThrow();
    const payload = JSON.stringify(authorized?.payload);
    expect(payload).not.toContain(voter.id);
    expect(payload).not.toContain(session.id);
    expect(payload).not.toContain(Buffer.from(session.tokenHash).toString('hex'));
  });

  it('never contains CPFs, voter identifier hashes, tokens or choices', async () => {
    const { election, cpfs } = await createVotingElection(t, clock, { voters: 2 });
    const token = (await authorizeVoter(t, election.id, cpfs[0] ?? '')).json<{ token: string }>()
      .token;
    await castBallot(t, {
      token,
      electionId: election.id,
      choice: { type: 'candidate', number: 20 },
    });

    const raw = JSON.stringify(
      await t.prisma.$queryRaw`SELECT * FROM audit_events`,
      (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v),
    );
    for (const cpf of cpfs) expect(raw).not.toContain(cpf.replace(/\D/g, ''));
    expect(raw).not.toContain(token);
    const hmacs = await t.prisma.voter.findMany({ select: { identifierHmac: true } });
    for (const { identifierHmac } of hmacs) {
      expect(raw).not.toContain(Buffer.from(identifierHmac).toString('hex'));
    }
    const ballot = await t.prisma.ballot.findFirstOrThrow();
    expect(raw).not.toContain(ballot.id);
  });

  it('failed operations leave no event (same transaction)', async () => {
    const election = await createElection(t, clock.now());
    await addCandidate(t, election.id, { number: 1, name: 'A' });
    const before = (await listEvents()).length;

    expect((await addCandidate(t, election.id, { number: 1, name: 'Dup' })).statusCode).toBe(409);
    expect((await registerVoter(t, election.id, '529.982.247-24')).statusCode).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/admin/elections/${election.id}/open`,
          headers: adminHeaders,
        })
      ).statusCode,
    ).toBe(422);
    expect(await listEvents()).toHaveLength(before);
  });

  it('filters by election and paginates by seq', async () => {
    const a = await createElection(t, clock.now());
    const b = await createElection(t, clock.now());
    await addCandidate(t, a.id, { number: 1, name: 'A' });
    await addCandidate(t, b.id, { number: 1, name: 'B' });

    expect((await listEvents(`?electionId=${a.id}`)).map((e) => e.electionId)).toEqual([
      a.id,
      a.id,
    ]);
    // Cada eleição tem a própria cadeia (seq 1, 2 em cada); a paginação usa o id global.
    expect((await listEvents(`?electionId=${b.id}`)).map((e) => e.seq)).toEqual([1, 2]);
    const all = await listEvents();
    const page = await listEvents(`?afterId=${all[0]?.id ?? 0}&limit=2`);
    expect(page.map((e) => e.id)).toEqual(all.slice(1, 3).map((e) => e.id));
  });

  it('audit endpoints are admin-only', async () => {
    for (const url of ['/admin/audit', '/admin/audit/verify']) {
      expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect(
        (await t.app.inject({ method: 'GET', url, headers: pollWorkerHeaders })).statusCode,
      ).toBe(401);
    }
  });

  it('rejects malformed query parameters', async () => {
    for (const query of [
      '?limit=0',
      '?limit=501',
      '?afterSeq=-1',
      '?electionId=x',
      '?anchorSeq=1',
      '?anchorHash=zz',
    ]) {
      const url = `/admin/audit${query.startsWith('?anchor') ? '/verify' : ''}${query}`;
      expect(
        (await t.app.inject({ method: 'GET', url, headers: adminHeaders })).statusCode,
        query,
      ).toBe(400);
    }
  });
});

describe('chain consistency', () => {
  it('stays valid and gap-free under concurrent audited operations', async () => {
    const { election, cpfs } = await createVotingElection(t, clock, { voters: 30 });
    const authorizations = await Promise.all([
      ...cpfs.map((cpf) => authorizeVoter(t, election.id, cpf)),
      ...Array.from({ length: 10 }, () =>
        t.app.inject({
          method: 'POST',
          url: '/admin/elections',
          headers: adminHeaders,
          payload: {
            name: 'Concorrente',
            startsAt: new Date(clock.now().getTime() + HOUR).toISOString(),
            endsAt: new Date(clock.now().getTime() + 2 * HOUR).toISOString(),
          },
        }),
      ),
    ]);
    expect(authorizations.map((r) => r.statusCode)).toEqual(authorizations.map(() => 201));

    const result = await verify();
    expect(result).toMatchObject({ valid: true });
    const total = await t.prisma.auditEvent.count();
    expect(result.eventCount).toBe(total);
    expect(result.chains).toBe(11); // 1 eleição com as habilitações + 10 criadas em paralelo
  });

  it('verify accepts a matching anchor on an election chain', async () => {
    const election = await createElection(t, clock.now());
    const { head } = await verify(`?electionId=${election.id}`);
    if (!head) throw new Error('empty chain');
    await addCandidate(t, election.id, { number: 1, name: 'A' }); // a cadeia cresce: continua válida
    expect(
      await verify(`?electionId=${election.id}&anchorSeq=${head.seq}&anchorHash=${head.hash}`),
    ).toMatchObject({ valid: true, chain: election.id });
  });

  it('elections created before the per-election chains keep using the legacy global chain', async () => {
    const election = await createElection(t, clock.now());
    // Simula o legado: a cadeia global já contém o ELECTION_CREATED desta eleição.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('TRUNCATE audit_events'),
      t.prisma.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER USER'),
    ]);
    const { appendAuditEvent } = await import('../../src/modules/audit/application/audit-log.js');
    const { computeEventHash, GENESIS_HASH } =
      await import('../../src/modules/audit/domain/audit-chain.js');
    const legacy = {
      format: 1 as const,
      chainKey: 'global',
      seq: 1,
      eventType: 'ELECTION_CREATED' as const,
      actorType: 'ADMIN' as const,
      actorIdentifier: 'legacy',
      electionId: election.id,
      payload: {},
      createdAt: new Date('2029-12-31T00:00:00Z'),
    };
    await t.prisma.auditEvent.create({
      data: {
        ...legacy,
        previousHash: GENESIS_HASH,
        eventHash: computeEventHash(legacy, GENESIS_HASH),
      },
    });

    const appended = await t.prisma.$transaction((tx) =>
      appendAuditEvent(
        tx,
        {
          eventType: 'ELECTION_OPENED',
          actor: { type: 'ADMIN', id: 'x' },
          electionId: election.id,
        },
        clock.now(),
      ),
    );
    expect(appended).toMatchObject({ chainKey: 'global', seq: 2 });
    expect(await verify()).toMatchObject({ valid: true, chains: 1 });
  });
});
