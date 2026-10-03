import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TestProject } from 'vitest/node';

export interface ServerInfo {
  name: string;
  url: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    servers: ServerInfo[];
  }
}

const children: ChildProcess[] = [];

async function waitHealthy(url: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${url}/health/ready`)).ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not become healthy`);
}

/**
 * Sobe as duas implementações contra o MESMO banco de teste (role urna_app), com rate limit
 * desligado: os testes disparam rajadas de requisições de propósito.
 */
export async function setup(project: TestProject): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // CI: só o ambiente
  }
  const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
  if (!new URL(databaseUrl).pathname.endsWith('_test'))
    throw new Error('TEST_DATABASE_URL must be a *_test database');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL },
    stdio: 'pipe',
  });
  execFileSync('npx', ['tsx', 'scripts/setup-app-role.ts', 'test'], { stdio: 'pipe' });

  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    RATE_LIMIT_PER_MINUTE: '0',
    LOG_LEVEL: 'warn',
    NODE_ENV: 'test',
  };
  const only = process.env.CONTRACT_ONLY; // "typescript" | "rust"
  const servers: ServerInfo[] = [];

  if (only !== 'rust') {
    children.push(
      spawn('npx', ['tsx', 'src/server.ts'], { env: { ...env, PORT: '3100' }, stdio: 'ignore' }),
    );
    servers.push({ name: 'typescript', url: 'http://127.0.0.1:3100' });
  }
  if (only !== 'typescript') {
    const cargo = `${process.env.HOME ?? ''}/.cargo/bin/cargo`;
    execFileSync(
      existsSync(cargo) ? cargo : 'cargo',
      ['build', '--release', '--manifest-path', 'rust/Cargo.toml'],
      { stdio: 'pipe' },
    );
    children.push(
      spawn('rust/target/release/urna-server', [], {
        env: { ...env, RUST_PORT: '3110' },
        stdio: 'ignore',
      }),
    );
    servers.push({ name: 'rust', url: 'http://127.0.0.1:3110' });
  }
  await Promise.all(servers.map((s) => waitHealthy(s.url)));
  project.provide('servers', servers);
}

export function teardown(): void {
  for (const child of children) child.kill('SIGTERM');
}
