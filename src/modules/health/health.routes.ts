import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../../database/client.js';

async function isDatabaseUp(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export function registerHealthRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  // Liveness: o processo responde. Não toca no banco.
  app.get('/health', () => ({ status: 'ok' }));

  // Readiness: o processo consegue atender requisições reais.
  app.get('/health/ready', async (request, reply) => {
    if (await isDatabaseUp(prisma)) {
      return { status: 'ok', database: 'up' };
    }
    request.log.warn('readiness check failed: database unreachable');
    return reply.status(503).send({ status: 'unavailable', database: 'down' });
  });
}
