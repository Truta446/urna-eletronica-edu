import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPrismaClient, type PrismaClient } from '../../src/database/client.js';

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

export async function createTestApp(options: { databaseUrl?: string } = {}): Promise<TestApp> {
  const prisma = createPrismaClient(options.databaseUrl ?? inject('databaseUrl'));
  const logs: Record<string, unknown>[] = [];
  const app = buildApp({
    env: { NODE_ENV: 'test', LOG_LEVEL: 'info' },
    prisma,
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
