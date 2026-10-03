import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPrismaClient, type PrismaClient } from '../../src/database/client.js';
import { generateToken, hashToken } from '../../src/security/tokens.js';
import type { Clock } from '../../src/shared/clock.js';

/** Token admin válido só durante esta execução da suíte. */
export const ADMIN_TOKEN = generateToken();
export const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}` } as const;
const ADMIN_CREDENTIALS = [{ label: 'test-admin', tokenHash: hashToken(ADMIN_TOKEN) }];
export const POLL_WORKER_TOKEN = generateToken();
export const pollWorkerHeaders = { authorization: `Bearer ${POLL_WORKER_TOKEN}` } as const;
const POLL_WORKER_CREDENTIALS = [
  { label: 'test-poll-worker', tokenHash: hashToken(POLL_WORKER_TOKEN) },
];
export const VOTING_SESSION_TTL_SECONDS = 300;
/** Chave de assinatura nova a cada execução. */
export const SIGNING_PRIVATE_KEY = generateKeyPairSync('ed25519').privateKey;
/** Pepper aleatório por execução: nenhum teste pode depender de um valor fixo. */
export const VOTER_ID_PEPPER = randomBytes(32);

export interface TestApp {
  app: FastifyInstance;
  prisma: PrismaClient;
  /** Linhas de log emitidas pela aplicação (JSON já parseado). */
  logs: Record<string, unknown>[];
  close: () => Promise<void>;
}

function captureLogs(sink: Record<string, unknown>[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) sink.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
}

export interface TestAppOptions {
  databaseUrl?: string;
  clock?: Clock;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const prisma = createPrismaClient(options.databaseUrl ?? inject('databaseUrl'));
  const logs: Record<string, unknown>[] = [];
  const app = buildApp({
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      ADMIN_CREDENTIALS,
      POLL_WORKER_CREDENTIALS,
      VOTER_ID_PEPPER,
      VOTING_SESSION_TTL_SECONDS,
      SIGNING_PRIVATE_KEY,
    },
    prisma,
    ...(options.clock && { clock: options.clock }),
    logStream: captureLogs(logs),
  });
  await app.ready();

  return {
    app,
    prisma,
    logs,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}
