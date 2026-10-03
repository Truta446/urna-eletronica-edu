import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../src/shared/errors/app-error.js';
import { registerErrorHandling } from '../../src/shared/errors/error-handler.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false, bodyLimit: 64 });
  registerErrorHandling(app);
  app.get('/not-found', () => {
    throw new NotFoundError('Election');
  });
  app.get('/conflict', () => {
    throw new ConflictError('Voter already registered');
  });
  app.post('/validate', (request) => z.object({ name: z.string().min(3) }).parse(request.body));
  app.get('/boom', () => {
    throw new Error('connection string postgresql://admin:secret@db leaked');
  });
  await app.ready();
});

afterAll(() => app.close());

describe('centralized error handling', () => {
  it('maps AppError subclasses to their status and code', async () => {
    const notFound = await app.inject({ method: 'GET', url: '/not-found' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Election not found' },
    });

    const conflict = await app.inject({ method: 'GET', url: '/conflict' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('maps ZodError to 400 with paths but without the received values', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: { name: 'xy' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', issues: [{ path: 'name' }] },
    });
    expect(response.body).not.toContain('"xy"');
  });

  it('hides internal error details behind a generic 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(response.body).not.toContain('secret');
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  it('rejects oversized bodies with 413', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: { name: 'x'.repeat(200) },
    });
    expect(response.statusCode).toBe(413);
  });

  it('returns a typed 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
  });
});
