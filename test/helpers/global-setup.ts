import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Trava de segurança: a suíte trunca tabelas, então só roda contra um banco cujo nome termina em `_test`.
 */
function resolveTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');

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

  const databaseUrl = resolveTestDatabaseUrl();
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  project.provide('databaseUrl', databaseUrl);
}
