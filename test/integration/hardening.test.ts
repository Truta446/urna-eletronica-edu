import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/database.js';
import { authorizeVoter, castBallot, createVotingElection } from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const clock = createFakeClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set(new Date('2030-01-01T12:00:00Z'));
  await resetDatabase(t.prisma);
});
afterAll(() => t.close());

describe('security headers', () => {
  it.each(['/health', '/nope', '/elections/not-a-uuid'])('are present on %s', async (url) => {
    const response = await t.app.inject({ method: 'GET', url });
    expect(response.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-store',
    });
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('access logs on sensitive routes', () => {
  it('authorizing and voting leave NO access log lines (timing correlation, T16)', async () => {
    const { election, cpfs } = await createVotingElection(t, clock);
    t.logs.length = 0;
    const { token } = (await authorizeVoter(t, election.id, cpfs[0] ?? '')).json<{
      token: string;
    }>();
    await castBallot(t, { token, electionId: election.id });

    const urls = t.logs.map((line) => JSON.stringify(line));
    expect(urls.filter((l) => l.includes('/voting-sessions') || l.includes('/ballots'))).toEqual(
      [],
    );
  });

  it('other routes are still logged', async () => {
    t.logs.length = 0;
    await t.app.inject({ method: 'GET', url: '/health' });
    expect(t.logs.some((l) => l.msg === 'incoming request')).toBe(true);
  });
});

describe('rate limiting', () => {
  let limited: TestApp;

  beforeAll(async () => {
    limited = await createTestApp({ clock, rateLimitPerMinute: 5 });
  });
  afterAll(() => limited.close());

  it('returns 429 with the standard error shape after the limit', async () => {
    const responses = [];
    for (let i = 0; i < 7; i++)
      responses.push(await limited.app.inject({ method: 'GET', url: '/health' }));
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(responses[6]?.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
  });
});
