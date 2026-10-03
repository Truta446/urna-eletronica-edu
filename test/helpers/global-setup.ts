import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Role de menor privilégio (urna_app): é com ela que a APLICAÇÃO conecta nos testes. */
    databaseUrl: string;
    /** Dono do schema: usado pelos testes para preparar cenários e simular atacantes. */
    ownerDatabaseUrl: string;
  }
}

/**
 * Trava de segurança: a suíte trunca tabelas, então só roda contra um banco cujo nome termina em `_test`.
 */
function requireTestUrl(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} is not set (see .env.example)`);
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against non-test database "${databaseName}"`);
  }
  return url;
}

export function setup(project: TestProject): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // Sem .env: usa apenas o ambiente (ex.: CI).
  }

  const databaseUrl = requireTestUrl('TEST_DATABASE_URL');
  const ownerDatabaseUrl = requireTestUrl('TEST_MIGRATION_DATABASE_URL');
  const env = { ...process.env, MIGRATION_DATABASE_URL: ownerDatabaseUrl };
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env, stdio: 'pipe' });
  execFileSync('npx', ['tsx', 'scripts/setup-app-role.ts', 'test'], {
    env: process.env,
    stdio: 'pipe',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide('ownerDatabaseUrl', ownerDatabaseUrl);
}
