import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  generateToken,
  hashToken,
  TOKEN_BYTES,
  TOKEN_PATTERN,
} from '../../src/security/tokens.js';

describe('generateToken', () => {
  it('produces 256 bits encoded as 43 base64url characters', () => {
    const token = generateToken();
    expect(token).toMatch(TOKEN_PATTERN);
    expect(Buffer.from(token, 'base64url')).toHaveLength(TOKEN_BYTES);
  });

  it('never repeats across a large sample', () => {
    const sample = new Set(Array.from({ length: 50_000 }, generateToken));
    expect(sample.size).toBe(50_000);
  });

  it('uses the whole alphabet (no obvious bias)', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 5_000; i++) {
      for (const char of generateToken()) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    expect(counts.size).toBe(64);
  });
});

describe('hashToken', () => {
  it('is deterministic SHA-256 (32 bytes)', () => {
    const token = generateToken();
    expect(hashToken(token)).toEqual(hashToken(token));
    expect(hashToken(token)).toHaveLength(32);
  });

  it('matches a known SHA-256 vector', () => {
    expect(hashToken('abc').toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('differs for different tokens', () => {
    expect(hashToken(generateToken())).not.toEqual(hashToken(generateToken()));
  });
});

describe('constantTimeEqual', () => {
  it('compares buffers including different lengths without throwing', () => {
    expect(constantTimeEqual(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
    expect(constantTimeEqual(Buffer.from('ab'), Buffer.from('ac'))).toBe(false);
    expect(constantTimeEqual(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
  });
});
