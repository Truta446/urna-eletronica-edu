import { defineConfig, env } from 'prisma/config';

// O Prisma 7 não carrega .env sozinho. Variáveis já definidas no ambiente (ex.: CI, testes)
// têm precedência, porque loadEnvFile não sobrescreve valores existentes.
try {
  process.loadEnvFile('.env');
} catch {
  // Sem .env: segue apenas com o ambiente do processo.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Migrations rodam como DONO do schema; a aplicação usa DATABASE_URL (role urna_app).
  datasource: { url: env('MIGRATION_DATABASE_URL') },
});
