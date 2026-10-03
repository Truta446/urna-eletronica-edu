import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPrismaClient } from './database/client.js';

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const app = buildApp({ env, prisma });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start server');
  await prisma.$disconnect();
  process.exit(1);
}
