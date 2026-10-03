import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ballotCommitment } from '../../src/security/ballot-crypto.js';
import { resetDatabase } from '../helpers/database.js';
import {
  castBallot,
  closeElection,
  createElectionWithTokens,
  tallyElection,
} from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * A apuração contra um superusuário que adultera o banco depois do fechamento, DESLIGANDO os
 * triggers. A prevenção falhou; a apuração precisa se recusar a contar e registrar a falha.
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

async function closedElection(votes = 4) {
  const { election, tokens } = await createElectionWithTokens(t, clock, { voters: votes });
  for (const token of tokens) {
    await castBallot(t, {
      token,
      electionId: election.id,
      choice: { type: 'candidate', number: 10 },
    });
  }
  await closeElection(t, clock, election);
  return election;
}

/** Superusuário: desliga TODOS os triggers da tabela durante o comando. */
async function asSuperuser(table: string, sql: string) {
  await t.prisma.$transaction([
    t.prisma.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ALL`),
    t.prisma.$executeRawUnsafe(sql),
    t.prisma.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ALL`),
  ]);
}

async function expectTallyRefused(electionId: string, reason: string) {
  const response = await tallyElection(t, electionId);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({
    error: { code: 'INTEGRITY_FAILURE', message: expect.stringContaining(reason) as unknown },
  });
  expect(await t.prisma.tallyResult.count()).toBe(0);
  const last = await t.prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: 'desc' } });
  expect(last).toMatchObject({ eventType: 'TALLY_FAILED', payload: { reason } });
  expect((await t.prisma.election.findUniqueOrThrow({ where: { id: electionId } })).status).toBe(
    'CLOSED',
  );
}

describe('tally integrity against database tampering', () => {
  it('switching a vote to another candidate is detected (commitment)', async () => {
    const election = await closedElection();
    await asSuperuser(
      'ballots',
      `UPDATE ballots SET kind = 'BLANK', candidate_id = NULL
                                     WHERE id = (SELECT id FROM ballots LIMIT 1)`,
    );
    await expectTallyRefused(election.id, 'COMMITMENT_MISMATCH');
  });

  it('switching a vote AND recomputing its commitment is detected (Merkle root)', async () => {
    const election = await closedElection();
    const target = await t.prisma.ballot.findFirstOrThrow();
    const forged = ballotCommitment({
      ballotId: target.id,
      electionId: election.id,
      kind: 'BLANK',
      candidateId: null,
    });
    await asSuperuser(
      'ballots',
      `UPDATE ballots SET kind = 'BLANK', candidate_id = NULL,
                                     commitment = '\\x${forged.toString('hex')}' WHERE id = '${target.id}'`,
    );
    await expectTallyRefused(election.id, 'MERKLE_ROOT_MISMATCH');
  });

  it('deleting a vote is detected', async () => {
    const election = await closedElection();
    await asSuperuser('ballots', 'DELETE FROM ballots WHERE id = (SELECT id FROM ballots LIMIT 1)');
    await expectTallyRefused(election.id, 'BALLOT_COUNT_MISMATCH');
  });

  it('inserting a well-formed extra vote is detected', async () => {
    const election = await closedElection();
    const candidate = await t.prisma.candidate.findFirstOrThrow({
      where: { electionId: election.id, number: 10 },
    });
    const id = randomUUID();
    const commitment = ballotCommitment({
      ballotId: id,
      electionId: election.id,
      kind: 'CANDIDATE',
      candidateId: candidate.id,
    });
    await asSuperuser(
      'ballots',
      `INSERT INTO ballots (id, election_id, kind, candidate_id, nullifier, commitment)
       VALUES ('${id}', '${election.id}', 'CANDIDATE', '${candidate.id}',
               '\\x${randomBytes(32).toString('hex')}', '\\x${commitment.toString('hex')}')`,
    );
    await expectTallyRefused(election.id, 'BALLOT_COUNT_MISMATCH');
  });

  it('forging the seal in the audit log is detected (signature)', async () => {
    const election = await closedElection();
    await asSuperuser(
      'audit_events',
      `UPDATE audit_events SET payload = jsonb_set(payload, '{ballots}', '5')
                                          WHERE event_type = 'BALLOT_BOX_SEALED'`,
    );
    await expectTallyRefused(election.id, 'SEAL_SIGNATURE_INVALID');
  });

  it('tampering with the audit chain before the seal is detected', async () => {
    const election = await closedElection();
    await asSuperuser(
      'audit_events',
      `UPDATE audit_events SET actor_identifier = 'mallory' WHERE seq = 1`,
    );
    await expectTallyRefused(election.id, 'AUDIT_CHAIN_INVALID');
  });

  it('an untampered election still tallies (control)', async () => {
    const election = await closedElection();
    expect((await tallyElection(t, election.id)).statusCode).toBe(201);
  });
});

describe('tally_results is immutable', () => {
  it('rejects UPDATE and DELETE (UE012)', async () => {
    const election = await closedElection();
    await tallyElection(t, election.id);
    for (const sql of [`UPDATE tally_results SET key_id = 'x'`, 'DELETE FROM tally_results']) {
      await expect(t.prisma.$executeRawUnsafe(sql)).rejects.toThrow(/UE012/);
    }
  });
});
