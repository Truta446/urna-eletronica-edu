import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

const env = readFileSync('.env', 'utf8');
const [ADMIN = '', POLL = ''] = [...env.matchAll(/é: (\S+)/g)].map((m) => m[1] ?? '');
export const ADMIN_TOKEN = ADMIN;
export const POLL_TOKEN = POLL;

export interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export function client(base: string) {
  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: {
      token?: string;
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined || options.raw !== undefined)
      headers['content-type'] ??= 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.raw !== undefined
        ? { body: options.raw }
        : options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
  }
  return { call, base };
}

export type Client = ReturnType<typeof client>;

/** CPF válido aleatório. */
export function cpf(): string {
  const d = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b % 10);
  const dig = (x: number[]) => {
    const r = (x.reduce((a, v, i) => a + v * (x.length + 1 - i), 0) * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const full = [...d, dig(d)];
  full.push(dig(full));
  return full.join('');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Eleição com janela REAL curta: começa em ~1 s e termina em `durationMs`.
 * Devolve id, CPFs cadastrados e o horário de término.
 */
export async function votingElection(
  c: Client,
  options: {
    voters?: number;
    candidates?: number[];
    durationMs?: number;
    encryptionPublicKey?: string;
  } = {},
) {
  const { voters = 3, candidates = [13, 45], durationMs = 6000 } = options;
  const start = Date.now() + 1000;
  const endsAt = new Date(start + durationMs);
  const created = await c.call<{ id: string }>('POST', '/admin/elections', {
    token: ADMIN_TOKEN,
    body: {
      name: `Contrato ${randomUUID().slice(0, 8)}`,
      startsAt: new Date(start).toISOString(),
      endsAt: endsAt.toISOString(),
      ...(options.encryptionPublicKey && { encryptionPublicKey: options.encryptionPublicKey }),
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  for (const number of candidates) {
    expect(
      (
        await c.call('POST', `/admin/elections/${id}/candidates`, {
          token: ADMIN_TOKEN,
          body: { number, name: `C${number}` },
        })
      ).status,
    ).toBe(201);
  }
  const cpfs = Array.from({ length: voters }, cpf);
  for (const v of cpfs) {
    expect(
      (
        await c.call('POST', `/admin/elections/${id}/voters`, {
          token: ADMIN_TOKEN,
          body: { voterIdentifier: v },
        })
      ).status,
    ).toBe(201);
  }
  expect((await c.call('POST', `/admin/elections/${id}/open`, { token: ADMIN_TOKEN })).status).toBe(
    200,
  );
  await sleep(Math.max(0, start - Date.now()) + 50);
  return { id, cpfs, endsAt };
}

export async function authorize(c: Client, electionId: string, voter: string): Promise<string> {
  const res = await c.call<{ token: string }>('POST', `/elections/${electionId}/voting-sessions`, {
    token: POLL_TOKEN,
    body: { voterIdentifier: voter },
  });
  expect(res.status).toBe(201);
  return res.body.token;
}

export function vote(
  c: Client,
  electionId: string,
  token: string,
  choice: unknown,
  key = randomUUID(),
) {
  return c.call('POST', '/ballots', {
    token,
    headers: { 'idempotency-key': key },
    body: { electionId, choice },
  });
}

export async function closeWhenAllowed(c: Client, electionId: string, endsAt: Date) {
  await sleep(Math.max(0, endsAt.getTime() - Date.now()) + 100);
  expect(
    (await c.call('POST', `/admin/elections/${electionId}/close`, { token: ADMIN_TOKEN })).status,
  ).toBe(200);
}
