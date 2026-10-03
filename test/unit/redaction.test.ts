import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/shared/logging/logger.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

// Nunca conecta: só exercita o logger.
const UNUSED_DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/unused';

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp({ databaseUrl: UNUSED_DATABASE_URL });
});

afterAll(() => testApp.close());

describe('log redaction', () => {
  it('does not log headers, query strings or client IP on requests', async () => {
    const token = 'vt_0123456789abcdefSECRETTOKEN';
    await testApp.app.inject({
      method: 'GET',
      url: `/health?token=${token}`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-SECRET' },
    });

    const serialized = JSON.stringify(testApp.logs);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('idem-SECRET');
    expect(serialized).not.toContain('remoteAddress');

    const incoming = testApp.logs.find((line) => line.msg === 'incoming request');
    expect(incoming?.req).toMatchObject({ method: 'GET', url: '/health' });
    expect(Object.keys(incoming?.req ?? {}).sort()).toEqual(['id', 'method', 'url']);
  });

  it('redacts sensitive fields if code accidentally logs them', () => {
    testApp.app.log.info(
      {
        token: 'raw-token',
        ballot: { choice: { candidate: 'CHOICE-MARKER' } },
        voter: { voterIdentifier: '123.456.789-00' },
        config: { pepper: 'pepper-value', privateKey: 'PRIVATE-KEY-MARKER' },
      },
      'oops',
    );

    const line = testApp.logs.find((entry) => entry.msg === 'oops');
    expect(line).toMatchObject({
      token: REDACTED,
      ballot: { choice: REDACTED },
      voter: { voterIdentifier: REDACTED },
      config: { pepper: REDACTED, privateKey: REDACTED },
    });
    // Marcadores textuais únicos: números como "42" aparecem por acaso em `pid`/`time`
    // e tornavam este teste intermitente.
    expect(JSON.stringify(line)).not.toMatch(
      /raw-token|123\.456|pepper-value|CHOICE-MARKER|PRIVATE-KEY-MARKER/,
    );
  });
});
