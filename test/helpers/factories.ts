import { expect } from 'vitest';
import type { TestApp } from './test-app.js';
import { adminHeaders } from './test-app.js';
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

export async function openElection({ app }: TestApp, electionId: string) {
  return app.inject({
    method: 'POST',
    url: `/admin/elections/${electionId}/open`,
    headers: adminHeaders,
  });
}
