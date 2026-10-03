import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/database.js';
import {
  addCandidate,
  createElection,
  createReadyElection,
  electionPayload,
  openElection,
  registerVoter,
  type ElectionBody,
} from '../helpers/factories.js';
import { createFakeClock, HOUR } from '../helpers/fake-clock.js';
import { adminHeaders, createTestApp, type TestApp } from '../helpers/test-app.js';

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

const post = (url: string, payload?: Record<string, unknown>) =>
  t.app.inject(
    payload
      ? { method: 'POST', url, headers: adminHeaders, payload }
      : { method: 'POST', url, headers: adminHeaders },
  );

async function openWithCandidate(): Promise<ElectionBody> {
  const election = await createReadyElection(t, clock.now());
  const response = await openElection(t, election.id);
  expect(response.statusCode).toBe(200);
  return response.json<ElectionBody>();
}

describe('POST /admin/elections', () => {
  it('creates an election in DRAFT', async () => {
    const payload = electionPayload(clock.now());
    const response = await post('/admin/elections', payload);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      name: payload.name,
      status: 'DRAFT',
      startsAt: payload.startsAt,
      endsAt: payload.endsAt,
      createdAt: expect.any(String) as unknown,
    });
  });

  it('generates random (v4) ids, never time-ordered ones', async () => {
    const { id } = await createElection(t, clock.now());
    expect(id[14]).toBe('4');
  });

  it('trims the name', async () => {
    const election = await createElection(t, clock.now(), { name: '  Grêmio  ' });
    expect(election.name).toBe('Grêmio');
  });

  it.each([
    ['missing name', { name: undefined }],
    ['empty name', { name: '   ' }],
    ['name too long', { name: 'x'.repeat(201) }],
    ['control characters in name', { name: 'Grêmio\nFAKE LOG LINE' }],
    ['date without timezone', { startsAt: '2030-01-01T13:00:00' }],
    ['non-date string', { endsAt: 'tomorrow' }],
    ['numeric timestamp', { startsAt: 1_900_000_000_000 }],
    ['mass assignment of status', { status: 'OPEN' }],
    ['mass assignment of id', { id: randomUUID() }],
  ])('rejects %s with 400', async (_label, overrides) => {
    const response = await post('/admin/elections', electionPayload(clock.now(), overrides));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it.each([
    ['ends before it starts', { endsAt: new Date(START.getTime() - HOUR).toISOString() }],
    ['starts in the past', { startsAt: new Date(START.getTime() - 1).toISOString() }],
    [
      'lasts more than 30 days',
      { endsAt: new Date(START.getTime() + 31 * 24 * HOUR).toISOString() },
    ],
  ])('rejects a schedule that %s with 422', async (_label, overrides) => {
    const response = await post('/admin/elections', electionPayload(clock.now(), overrides));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'BUSINESS_RULE_VIOLATION' } });
  });

  it('rejects non-JSON bodies', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/admin/elections',
      headers: { ...adminHeaders, 'content-type': 'text/plain' },
      payload: 'name=x',
    });
    expect(response.statusCode).toBe(415);
  });
});

describe('GET /elections/:id', () => {
  it('returns the election publicly (no admin token)', async () => {
    const election = await createElection(t, clock.now());
    const response = await t.app.inject({ method: 'GET', url: `/elections/${election.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(election);
  });

  it('returns 404 for an unknown id', async () => {
    const response = await t.app.inject({ method: 'GET', url: `/elections/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });

  it.each([
    'not-a-uuid',
    '1',
    "'; DROP TABLE elections; --",
    '00000000-0000-0000-0000-00000000000g',
  ])('returns 400 for malformed id %j', async (id) => {
    const response = await t.app.inject({
      method: 'GET',
      url: `/elections/${encodeURIComponent(id)}`,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /admin/elections/:id/open', () => {
  it('opens a DRAFT election that has candidates', async () => {
    const opened = await openWithCandidate();
    expect(opened.status).toBe('OPEN');
  });

  it('refuses to open without candidates (422)', async () => {
    const election = await createElection(t, clock.now());
    await registerVoter(t, election.id);
    const response = await openElection(t, election.id);
    expect(response.statusCode).toBe(422);
  });

  it('refuses to open without voters (422)', async () => {
    const election = await createElection(t, clock.now());
    await addCandidate(t, election.id, { number: 10, name: 'Ana' });
    const response = await openElection(t, election.id);
    expect(response.statusCode).toBe(422);
  });

  it('refuses to open twice (409)', async () => {
    const election = await openWithCandidate();
    const response = await openElection(t, election.id);
    expect(response.statusCode).toBe(409);
  });

  it('refuses to open after the window has ended (422)', async () => {
    const election = await createReadyElection(t, clock.now());
    clock.set(new Date(election.endsAt));
    const response = await openElection(t, election.id);
    expect(response.statusCode).toBe(422);
  });

  it('returns 404 for unknown elections', async () => {
    const response = await openElection(t, randomUUID());
    expect(response.statusCode).toBe(404);
  });

  it('opens exactly once under 20 concurrent requests', async () => {
    const election = await createReadyElection(t, clock.now());

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => openElection(t, election.id)),
    );
    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
  });
});

describe('POST /admin/elections/:id/close', () => {
  it('closes an OPEN election after endsAt', async () => {
    const election = await openWithCandidate();
    clock.set(new Date(election.endsAt));
    const response = await post(`/admin/elections/${election.id}/close`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'CLOSED' });
  });

  it('refuses to close before endsAt, so voting cannot be cut short (422)', async () => {
    const election = await openWithCandidate();
    clock.set(new Date(new Date(election.endsAt).getTime() - 1));
    const response = await post(`/admin/elections/${election.id}/close`);
    expect(response.statusCode).toBe(422);
  });

  it('refuses to close a DRAFT election (409)', async () => {
    const election = await createElection(t, clock.now());
    clock.set(new Date(election.endsAt));
    const response = await post(`/admin/elections/${election.id}/close`);
    expect(response.statusCode).toBe(409);
  });

  it('closes exactly once under concurrent requests', async () => {
    const election = await openWithCandidate();
    clock.set(new Date(election.endsAt));
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => post(`/admin/elections/${election.id}/close`)),
    );
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });
});
