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
    env: { NODE_ENV: 'test', LOG_LEVEL: 'info', ADMIN_CREDENTIALS },
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
