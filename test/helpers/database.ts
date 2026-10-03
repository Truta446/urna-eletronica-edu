import type { PrismaClient } from '../../src/database/client.js';

/**
 * Esvazia todas as tabelas da aplicação. TRUNCATE não dispara triggers de linha, então funciona
 * mesmo nas tabelas append-only. A trava de `_test` no global-setup impede rodar isso em dev.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;

  const list = tables.map(({ tablename }) => `"public"."${tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
