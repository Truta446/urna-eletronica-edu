import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../src/database/client.js';
import { appendAuditEvent } from '../../src/modules/audit/application/audit-log.js';
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
 * ATAQUES A3 e A4 (Fase 10), com as credenciais da APLICAÇÃO (urna_app), sem a chave de assinatura.
 */
const clock = createFakeClock();
let t: TestApp;
let attacker: PrismaClient;

beforeAll(async () => {
  t = await createTestApp({ clock });
  attacker = createPrismaClient(inject('databaseUrl'));
});
beforeEach(async () => {
  clock.set(new Date('2030-01-01T12:00:00Z'));
  await resetDatabase(t.prisma);
});
afterAll(async () => {
  await attacker.$disconnect();
  await t.close();
});

async function closedElection() {
  const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 3 });
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

describe('attack A3: a second BALLOT_BOX_SEALED event', () => {
  it('REGRESSION: the tally refuses an election with more than one seal', async () => {
    const election = await closedElection();
    const seal = await attacker.auditEvent.findFirstOrThrow({
      where: { electionId: election.id, eventType: 'BALLOT_BOX_SEALED' },
    });
    await attacker.$transaction((tx) =>
      appendAuditEvent(
        tx,
        {
          eventType: 'BALLOT_BOX_SEALED',
          actor: { type: 'SYSTEM', id: 'urna-edu' },
          electionId: election.id,
          payload: seal.payload as Record<string, string | number>,
        },
        clock.now(),
      ),
    );

    const response = await tallyElection(t, election.id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { message: expect.stringContaining('SEAL_DUPLICATED') as unknown },
    });
  });
});

describe('attack A4: a forged result written directly to tally_results', () => {
  it('the database alone does not stop it (status is a column the app may update)', async () => {
    const election = await closedElection();
    await attacker.election.update({ where: { id: election.id }, data: { status: 'TALLIED' } });
    await attacker.tallyResult.create({
      data: {
        electionId: election.id,
        result: { candidates: [], blank: 999, null: 0, totalBallots: 999 },
        merkleRoot: randomBytes(32),
        resultHash: randomBytes(32),
        signature: randomBytes(64).toString('base64url'),
        keyId: 'forged',
        createdAt: clock.now(),
      },
    });
    expect(await t.prisma.tallyResult.count()).toBe(1);
  });

  it('REGRESSION: the API refuses to publish a result whose signature does not verify', async () => {
    const election = await closedElection();
    await attacker.election.update({ where: { id: election.id }, data: { status: 'TALLIED' } });
    await attacker.tallyResult.create({
      data: {
        electionId: election.id,
        result: { candidates: [], blank: 999, null: 0, totalBallots: 999 },
        merkleRoot: randomBytes(32),
        resultHash: randomBytes(32),
        signature: randomBytes(64).toString('base64url'),
        keyId: 'forged',
        createdAt: clock.now(),
      },
    });

    for (const path of ['tally', 'ballots']) {
      const response = await t.app.inject({
        method: 'GET',
        url: `/elections/${election.id}/${path}`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'INTEGRITY_FAILURE' } });
      expect(response.body).not.toContain('999');
    }
  });

  it('a genuine result is still published (control)', async () => {
    const election = await closedElection();
    expect((await tallyElection(t, election.id)).statusCode).toBe(201);
    const response = await t.app.inject({ method: 'GET', url: `/elections/${election.id}/tally` });
    expect(response.statusCode).toBe(200);
  });
});
