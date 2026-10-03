import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../src/database/client.js';
import { ballotCommitment } from '../../src/security/ballot-crypto.js';
import { resetDatabase } from '../helpers/database.js';
import {
  authorizeVoter,
  castBallot,
  closeElection,
  createVotingElection,
  tallyElection,
} from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * ATAQUE A1 (Fase 10): enchimento de urna com as credenciais do BANCO da aplicação.
 *
 * O atacante tem `urna_app` (ex.: DATABASE_URL vazada), mas não tem a chave de assinatura.
 * Para cada eleitor AUSENTE, numa transação: marca has_voted, cria e consome uma sessão e
 * insere um voto com commitment válido. Todos os balanços do banco continuam fechando.
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

async function stuffAbsentVoters(electionId: string, candidateNumber: number) {
  const candidate = await attacker.candidate.findFirstOrThrow({
    where: { electionId, number: candidateNumber },
  });
  const absent = await attacker.voter.findMany({ where: { electionId, hasVoted: false } });
  for (const voter of absent) {
    await attacker.$transaction(async (tx) => {
      await tx.voter.update({ where: { id: voter.id }, data: { hasVoted: true } });
      const session = await tx.votingSession.create({
        data: {
          electionId,
          tokenHash: randomBytes(32),
          expiresAt: new Date('2030-01-01T23:00:00Z'),
        },
      });
      await tx.votingSession.update({ where: { id: session.id }, data: { consumed: true } });
      const id = randomUUID();
      await tx.ballot.create({
        data: {
          id,
          electionId,
          kind: 'CANDIDATE',
          candidateId: candidate.id,
          nullifier: randomBytes(32),
          commitment: ballotCommitment({
            ballotId: id,
            electionId,
            kind: 'CANDIDATE',
            candidateId: candidate.id,
          }),
        },
      });
    });
  }
  return absent.length;
}

describe('attack A1: ballot stuffing with the application database role', () => {
  it('succeeds AT THE DATABASE LEVEL (all constraints and balances still hold)', async () => {
    const { election, cpfs } = await createVotingElection(t, clock, { voters: 4 });
    for (const cpf of cpfs.slice(0, 2)) {
      const { token } = (await authorizeVoter(t, election.id, cpf)).json<{ token: string }>();
      await castBallot(t, {
        token,
        electionId: election.id,
        choice: { type: 'candidate', number: 10 },
      });
    }

    expect(await stuffAbsentVoters(election.id, 20)).toBe(2);
    expect(await t.prisma.ballot.count()).toBe(4);
  });

  it('REGRESSION: the tally detects it — authorizations without a signed audit event', async () => {
    const { election, cpfs } = await createVotingElection(t, clock, { voters: 4 });
    for (const cpf of cpfs.slice(0, 2)) {
      const { token } = (await authorizeVoter(t, election.id, cpf)).json<{ token: string }>();
      await castBallot(t, {
        token,
        electionId: election.id,
        choice: { type: 'candidate', number: 10 },
      });
    }
    await stuffAbsentVoters(election.id, 20);
    await closeElection(t, clock, election);

    const response = await tallyElection(t, election.id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { message: expect.stringContaining('AUTHORIZATION_EVENTS_MISMATCH') as unknown },
    });
  });

  it('REGRESSION: forging VOTER_AUTHORIZED events (correct hash chain, no signing key) is also detected', async () => {
    const { election, cpfs } = await createVotingElection(t, clock, { voters: 3 });
    const { token } = (await authorizeVoter(t, election.id, cpfs[0] ?? '')).json<{
      token: string;
    }>();
    await castBallot(t, { token, electionId: election.id });
    const stuffed = await stuffAbsentVoters(election.id, 20);

    // O atacante também escreve eventos de auditoria encadeados corretamente (ele sabe calcular
    // os hashes), copiando o payload assinado de um evento legítimo ou inventando uma assinatura.
    const { appendAuditEvent } = await import('../../src/modules/audit/application/audit-log.js');
    const legit = await attacker.auditEvent.findFirstOrThrow({
      where: { eventType: 'VOTER_AUTHORIZED' },
    });
    const legitPayload = legit.payload as Record<string, string>;
    for (let i = 0; i < stuffed; i++) {
      await attacker.$transaction((tx) =>
        appendAuditEvent(
          tx,
          {
            eventType: 'VOTER_AUTHORIZED',
            actor: { type: 'POLL_WORKER', id: 'test-poll-worker' },
            electionId: election.id,
            // 1º: cópia exata (nonce repetido); 2º: assinatura inventada.
            payload:
              i === 0 ? legitPayload : { ...legitPayload, nonce: randomBytes(16).toString('hex') },
          },
          clock.now(),
        ),
      );
    }
    await closeElection(t, clock, election);

    const response = await tallyElection(t, election.id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { message: expect.stringContaining('AUTHORIZATION_EVENTS_MISMATCH') as unknown },
    });
  });
});
