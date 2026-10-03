import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createPrismaClient } from '../../src/database/client.js';
import { registerErrorHandling } from '../../src/shared/errors/error-handler.js';

/**
 * Mensagens do PostgreSQL podem trazer a linha inteira ("Failing row contains (...)").
 * Numa tabela de votos, isso seria o próprio voto no log.
 */
const prisma = createPrismaClient(inject('databaseUrl'));
const lines: string[] = [];
const app = Fastify({
  logger: {
    level: 'info',
    stream: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    }),
  },
});

const SENSITIVE_NAME = 'SENSITIVE-ROW-CONTENT';

beforeAll(async () => {
  registerErrorHandling(app);
  app.post('/violate-check', async () =>
    prisma.election.create({
      data: { name: SENSITIVE_NAME, startsAt: new Date(2e12), endsAt: new Date(1e12) },
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('database errors reaching the 500 handler', () => {
  it('log only name, Prisma code and SQLSTATE — never row contents', async () => {
    const response = await app.inject({ method: 'POST', url: '/violate-check' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(SENSITIVE_NAME);

    const errorLine = lines.find((line) => line.includes('unhandled error'));
    expect(errorLine).toBeDefined();
    expect(JSON.parse(errorLine ?? '{}')).toMatchObject({
      databaseError: { prismaCode: 'P2039', sqlState: '23514' },
    });
    expect(lines.join('\n')).not.toContain(SENSITIVE_NAME);
    expect(lines.join('\n')).not.toContain('Failing row');
  });
});
