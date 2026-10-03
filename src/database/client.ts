import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type { PrismaClient };

/**
 * Query logging do Prisma fica DESLIGADO de propósito: os parâmetros das queries
 * conteriam votos e hashes de tokens.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  return new PrismaClient({ adapter });
}
