import { describe, expect, it } from 'vitest';
import { InvalidEnvironmentError, loadEnv } from '../../src/config/env.js';

const HASH = 'a'.repeat(64);
const validEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  ADMIN_CREDENTIALS: `alice:${HASH}`,
};

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    expect(loadEnv(validEnv)).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: validEnv.DATABASE_URL,
      ADMIN_CREDENTIALS: [{ label: 'alice', tokenHash: Buffer.from(HASH, 'hex') }],
    });
  });

  it('coerces PORT from string', () => {
    expect(loadEnv({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it.each([
    ['missing DATABASE_URL', { ...validEnv, DATABASE_URL: undefined }, 'DATABASE_URL'],
    [
      'non-postgres DATABASE_URL',
      { ...validEnv, DATABASE_URL: 'mysql://u:p@h/db' },
      'DATABASE_URL',
    ],
    [
      'missing ADMIN_CREDENTIALS',
      { ...validEnv, ADMIN_CREDENTIALS: undefined },
      'ADMIN_CREDENTIALS',
    ],
    ['PORT out of range', { ...validEnv, PORT: '70000' }, 'PORT'],
    ['PORT not a number', { ...validEnv, PORT: 'abc' }, 'PORT'],
    ['unknown NODE_ENV', { ...validEnv, NODE_ENV: 'staging' }, 'NODE_ENV'],
    ['unknown LOG_LEVEL', { ...validEnv, LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
  ])('rejects %s', (_label, source, variable) => {
    expect(() => loadEnv(source)).toThrow(InvalidEnvironmentError);
    expect(() => loadEnv(source)).toThrow(variable);
  });

  it('never echoes the invalid value, which may be a secret', () => {
    const secret = 'super-secret-password';
    try {
      loadEnv({ ...validEnv, DATABASE_URL: `mysql://admin:${secret}@db.internal/app` });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain('DATABASE_URL');
      expect(String(error)).not.toContain(secret);
    }
  });
});
