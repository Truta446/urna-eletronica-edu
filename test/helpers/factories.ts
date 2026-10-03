import { expect } from 'vitest';
import type { TestApp } from './test-app.js';
import { adminHeaders, pollWorkerHeaders } from './test-app.js';
import type { FakeClock } from './fake-clock.js';
import { randomCpf } from './cpf.js';
import { HOUR } from './fake-clock.js';

export interface ElectionBody {
  id: string;
  name: string;
  status: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}

export function electionPayload(now: Date, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Eleição do Grêmio',
    startsAt: new Date(now.getTime() + HOUR).toISOString(),
    endsAt: new Date(now.getTime() + 9 * HOUR).toISOString(),
    ...overrides,
  };
}

export async function createElection(
  { app }: TestApp,
  now: Date,
  overrides: Record<string, unknown> = {},
): Promise<ElectionBody> {
  const response = await app.inject({
    method: 'POST',
    url: '/admin/elections',
    headers: adminHeaders,
    payload: electionPayload(now, overrides),
  });
  expect(response.statusCode).toBe(201);
  return response.json<ElectionBody>();
}

export async function addCandidate(
  { app }: TestApp,
  electionId: string,
  candidate: { number: number; name: string },
) {
  return app.inject({
    method: 'POST',
    url: `/admin/elections/${electionId}/candidates`,
    headers: adminHeaders,
    payload: candidate,
  });
}

export async function registerVoter({ app }: TestApp, electionId: string, cpf = randomCpf()) {
  return app.inject({
    method: 'POST',
    url: `/admin/elections/${electionId}/voters`,
    headers: adminHeaders,
    payload: { voterIdentifier: cpf },
  });
}

/** Eleição pronta para abrir: 1 candidato e 1 eleitor. */
export async function createReadyElection(t: TestApp, now: Date): Promise<ElectionBody> {
  const election = await createElection(t, now);
  expect((await addCandidate(t, election.id, { number: 10, name: 'Ana' })).statusCode).toBe(201);
  expect((await registerVoter(t, election.id)).statusCode).toBe(201);
  return election;
}

export async function authorizeVoter({ app }: TestApp, electionId: string, cpf: string) {
  return app.inject({
    method: 'POST',
    url: `/elections/${electionId}/voting-sessions`,
    headers: pollWorkerHeaders,
    payload: { voterIdentifier: cpf },
  });
}

/**
 * Eleição OPEN, com o relógio já dentro da janela de votação.
 * Devolve os CPFs cadastrados para os testes habilitarem.
 */
export async function createVotingElection(
  t: TestApp,
  clock: FakeClock,
  options: { voters?: number; candidates?: number[] } = {},
): Promise<{ election: ElectionBody; cpfs: string[] }> {
  const { voters = 1, candidates = [10, 20] } = options;
  const election = await createElection(t, clock.now());
  for (const number of candidates) {
    expect((await addCandidate(t, election.id, { number, name: `C${number}` })).statusCode).toBe(
      201,
    );
  }
  const cpfs = Array.from({ length: voters }, () => randomCpf());
  for (const cpf of cpfs) expect((await registerVoter(t, election.id, cpf)).statusCode).toBe(201);
  expect((await openElection(t, election.id)).statusCode).toBe(200);
  clock.set(new Date(election.startsAt));
  return { election, cpfs };
}

export async function openElection({ app }: TestApp, electionId: string) {
  return app.inject({
    method: 'POST',
    url: `/admin/elections/${electionId}/open`,
    headers: adminHeaders,
  });
}
