import type { PrismaClient } from '../../src/database/client.js';

/**
 * Esvazia todas as tabelas da aplicação. TRUNCATE não dispara triggers de linha, mas
 * `audit_events` tem um trigger que bloqueia TRUNCATE: ele é desligado SÓ dentro desta
 * transação. Isso exige ser dono da tabela, o que a role da aplicação não será (Fase 9).
 * A trava de `_test` no global-setup impede rodar isto contra o banco de dev.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;

  const list = tables.map(({ tablename }) => `"public"."${tablename}"`).join(', ');
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate'),
    prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`),
    prisma.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate'),
  ]);
}
