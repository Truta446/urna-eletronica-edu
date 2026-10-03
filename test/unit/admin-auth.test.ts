import { describe, expect, it } from 'vitest';
import { adminCredentialsSchema } from '../../src/security/admin-credentials.js';
import { generateToken, hashToken } from '../../src/security/tokens.js';
import { extractBearerToken, findAdmin } from '../../src/shared/http/admin-auth.js';

const hex = (token: string) => hashToken(token).toString('hex');

describe('adminCredentialsSchema', () => {
  it('parses label:sha256hex pairs', () => {
    const a = generateToken();
    const b = generateToken();
    const parsed = adminCredentialsSchema.parse(`alice:${hex(a)}, bob.ops:${hex(b)}`);
    expect(parsed.map((c) => c.label)).toEqual(['alice', 'bob.ops']);
    expect(parsed[0]?.tokenHash).toEqual(hashToken(a));
  });

  it.each([
    ['empty', ''],
    ['raw token instead of hash', `alice:${generateToken()}`],
    ['uppercase label', `Alice:${'a'.repeat(64)}`],
    ['short hash', `alice:${'a'.repeat(63)}`],
    ['missing label', `:${'a'.repeat(64)}`],
    ['duplicate label', `alice:${'a'.repeat(64)},alice:${'b'.repeat(64)}`],
    ['duplicate hash', `alice:${'a'.repeat(64)},bob:${'a'.repeat(64)}`],
  ])('rejects %s', (_label, raw) => {
    expect(adminCredentialsSchema.safeParse(raw).success).toBe(false);
  });

  it('does not echo the offending entry in the error', () => {
    const secret = generateToken();
    const result = adminCredentialsSchema.safeParse(`alice:${secret}`);
    expect(JSON.stringify(result.error)).not.toContain(secret);
  });
});

describe('extractBearerToken', () => {
  const token = generateToken();

  it('accepts "Bearer <token>"', () => {
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
  });

  it.each([
    ['missing header', undefined],
    ['wrong scheme', `Basic ${token}`],
    ['lowercase scheme', `bearer ${token}`],
    ['extra spaces', `Bearer  ${token}`],
    ['trailing data', `Bearer ${token} x`],
    ['malformed token', 'Bearer not-a-token'],
    ['oversized token', `Bearer ${token}${token}`],
  ])('rejects %s', (_label, header) => {
    expect(extractBearerToken(header)).toBeUndefined();
  });
});

describe('findAdmin', () => {
  const alice = generateToken();
  const bob = generateToken();
  const credentials = [
    { label: 'alice', tokenHash: hashToken(alice) },
    { label: 'bob', tokenHash: hashToken(bob) },
  ];

  it('identifies the matching operator', () => {
    expect(findAdmin(credentials, bob)).toEqual({ type: 'ADMIN', id: 'bob' });
  });

  it('rejects unknown tokens', () => {
    expect(findAdmin(credentials, generateToken())).toBeUndefined();
  });
});
