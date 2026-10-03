import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateToken } from '../../src/security/tokens.js';
import { resetDatabase } from '../helpers/database.js';
import { electionPayload } from '../helpers/factories.js';
import { ADMIN_TOKEN, createTestApp, type TestApp } from '../helpers/test-app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(() => resetDatabase(t.prisma));
afterAll(() => t.close());

const adminRoutes = [
  ['POST', '/admin/elections'],
  ['POST', `/admin/elections/${randomUUID()}/open`],
  ['POST', `/admin/elections/${randomUUID()}/close`],
  ['POST', `/admin/elections/${randomUUID()}/candidates`],
  ['POST', `/admin/elections/${randomUUID()}/voters`],
] as const;

const badHeaders: [string, Record<string, string>][] = [
  ['no header', {}],
  ['unknown token', { authorization: `Bearer ${generateToken()}` }],
  ['token hash instead of token', { authorization: `Bearer ${'a'.repeat(43)}` }],
  ['wrong scheme', { authorization: `Basic ${ADMIN_TOKEN}` }],
  ['token without scheme', { authorization: ADMIN_TOKEN }],
];

describe('admin authentication', () => {
  for (const [method, url] of adminRoutes) {
    for (const [label, headers] of badHeaders) {
      it(`${method} ${url.replace(/[0-9a-f-]{36}/, ':id')} rejects ${label}`, async () => {
        const response = await t.app.inject({
          method,
          url,
          headers,
          payload: electionPayload(new Date(Date.now() + 60_000)),
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
        });
      });
    }
  }

  it('authenticates before validating, so the body shape leaks nothing to anonymous callers', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/admin/elections',
      payload: { garbage: true },
    });
    expect(response.statusCode).toBe(401);
  });

  it('authenticates before parsing, so malformed JSON from anonymous callers is still 401', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/admin/elections',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not create anything on a rejected request', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/admin/elections',
      payload: electionPayload(new Date(Date.now() + 60_000)),
    });
    expect(await t.prisma.election.count()).toBe(0);
  });
});
