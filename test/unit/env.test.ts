import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidEnvironmentError, loadEnv } from '../../src/config/env.js';

const HASH = 'a'.repeat(64);
const POLL_HASH = 'b'.repeat(64);
const PEPPER = Buffer.alloc(32, 7);
const SIGNING_KEY = generateKeyPairSync('ed25519').privateKey;
const validEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  ADMIN_CREDENTIALS: `alice:${HASH}`,
  POLL_WORKER_CREDENTIALS: `mesario:${POLL_HASH}`,
  VOTER_ID_PEPPER: PEPPER.toString('base64url'),
  SIGNING_PRIVATE_KEY: SIGNING_KEY.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
};

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    const { SIGNING_PRIVATE_KEY, ...env } = loadEnv(validEnv);
    expect(SIGNING_PRIVATE_KEY.equals(SIGNING_KEY)).toBe(true);
    expect(env).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: validEnv.DATABASE_URL,
      ADMIN_CREDENTIALS: [{ label: 'alice', tokenHash: Buffer.from(HASH, 'hex') }],
      POLL_WORKER_CREDENTIALS: [{ label: 'mesario', tokenHash: Buffer.from(POLL_HASH, 'hex') }],
      VOTER_ID_PEPPER: PEPPER,
      VOTING_SESSION_TTL_SECONDS: 300,
      RATE_LIMIT_PER_MINUTE: 300,
    });
  });

  it('coerces PORT from string', () => {
    expect(loadEnv({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it.each([
    [
      'missing SIGNING_PRIVATE_KEY',
      { ...validEnv, SIGNING_PRIVATE_KEY: undefined },
      'SIGNING_PRIVATE_KEY',
    ],
    [
      'non-Ed25519 SIGNING_PRIVATE_KEY',
      {
        ...validEnv,
        SIGNING_PRIVATE_KEY: generateKeyPairSync('x25519')
          .privateKey.export({ format: 'der', type: 'pkcs8' })
          .toString('base64url'),
      },
      'SIGNING_PRIVATE_KEY',
    ],
    [
      'missing POLL_WORKER_CREDENTIALS',
      { ...validEnv, POLL_WORKER_CREDENTIALS: undefined },
      'POLL_WORKER_CREDENTIALS',
    ],
    [
      'the same token as ADMIN and POLL_WORKER (separation of duties)',
      { ...validEnv, POLL_WORKER_CREDENTIALS: `mesario:${HASH}` },
      'POLL_WORKER_CREDENTIALS',
    ],
    [
      'TTL below 30s',
      { ...validEnv, VOTING_SESSION_TTL_SECONDS: '29' },
      'VOTING_SESSION_TTL_SECONDS',
    ],
    [
      'TTL above 1h',
      { ...validEnv, VOTING_SESSION_TTL_SECONDS: '3601' },
      'VOTING_SESSION_TTL_SECONDS',
    ],
    ['missing VOTER_ID_PEPPER', { ...validEnv, VOTER_ID_PEPPER: undefined }, 'VOTER_ID_PEPPER'],
    [
      'short VOTER_ID_PEPPER',
      { ...validEnv, VOTER_ID_PEPPER: Buffer.alloc(31).toString('base64url') },
      'VOTER_ID_PEPPER',
    ],
    [
      'non-base64url VOTER_ID_PEPPER',
      { ...validEnv, VOTER_ID_PEPPER: `${'a'.repeat(43)}+/=` },
      'VOTER_ID_PEPPER',
    ],
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

  describe('production', () => {
    const prod = {
      ...validEnv,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://urna_app:p@db/urna',
      ADMIN_CREDENTIALS: `ops-alice:${HASH}`,
      POLL_WORKER_CREDENTIALS: `mesario-1:${POLL_HASH}`,
    };

    it('accepts a production-grade configuration', () => {
      expect(() => loadEnv(prod)).not.toThrow();
    });

    it.each([
      ['dev-* credentials', { ADMIN_CREDENTIALS: `dev-admin:${HASH}` }, 'ADMIN_CREDENTIALS'],
      ['verbose logging', { LOG_LEVEL: 'debug' }, 'LOG_LEVEL'],
      ['rate limit disabled', { RATE_LIMIT_PER_MINUTE: '0' }, 'RATE_LIMIT_PER_MINUTE'],
      [
        'a privileged database role',
        { DATABASE_URL: 'postgresql://postgres:p@db/urna' },
        'DATABASE_URL',
      ],
    ])('rejects %s', (_label, override, variable) => {
      expect(() => loadEnv({ ...prod, ...override })).toThrow(variable);
    });
  });
});
