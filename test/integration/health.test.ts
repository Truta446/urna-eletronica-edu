import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('health endpoints', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(() => testApp.close());

  it('GET /health reports liveness without touching the database', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports the real database as up', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: 'up' });
  });
});

describe('health endpoints with the database down', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ databaseUrl: 'postgresql://u:p@127.0.0.1:1/nowhere' });
  });

  afterAll(() => testApp.close());

  it('GET /health/ready returns 503 without leaking connection details', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', database: 'down' });
  });
});
