/**
 * Simulação em escala "nacional": muitas SEÇÕES (eleições pequenas) votando ao mesmo tempo,
 * como no Brasil (~470 mil seções de algumas centenas de eleitores).
 *
 * Uso: npm run bench:national -- <seções> <eleitores por seção> <requisições simultâneas> [processos]
 *      ex.: npm run bench:national -- 200 100 64 8
 * Com [processos] > 1, a votação roda em N processos Node independentes (como N instâncias da
 * aplicação atrás de um balanceador), todos contra o mesmo PostgreSQL; as requisições
 * simultâneas são divididas entre eles.
 *
 * Além de vazão e latência, amostra o PostgreSQL a cada 100 ms para mostrar ONDE as conexões
 * esperam (pg_stat_activity.wait_event).
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClient } from '../src/database/client.js';
import { generateToken, hashToken } from '../src/security/tokens.js';
import { createVoterIdentifierHasher } from '../src/security/voter-identifier.js';

const HOUR = 3_600_000;

interface Plan {
  ids: string[];
  perSection: number;
  now: number;
  adminToken: string;
  pollToken: string;
}

const appUrl = process.env.BENCH_DATABASE_URL ?? '';
const ownerUrl = process.env.BENCH_MIGRATION_DATABASE_URL ?? '';
if (
  !new URL(appUrl).pathname.endsWith('_bench') ||
  !new URL(ownerUrl).pathname.endsWith('_bench')
) {
  throw new Error('BENCH_* must point to a *_bench database');
}

function cpf(i: number): string {
  const base = Array.from(String(100_000_000 + i).padStart(9, '0'), Number);
  const digit = (d: number[]) => {
    const rest = (d.reduce((acc, v, k) => acc + v * (d.length + 1 - k), 0) * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const full = [...base, digit(base)];
  full.push(digit(full));
  return full.join('');
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

async function startApp(plan: Pick<Plan, 'now' | 'adminToken' | 'pollToken'>) {
  const env = loadEnv({ ...process.env, DATABASE_URL: appUrl });
  const prisma = createPrismaClient(appUrl);
  const clock = { current: plan.now };
  const app = await buildApp({
    env: {
      ...env,
      LOG_LEVEL: 'silent',
      RATE_LIMIT_PER_MINUTE: 0,
      ADMIN_CREDENTIALS: [{ label: 'bench-admin', tokenHash: hashToken(plan.adminToken) }],
      POLL_WORKER_CREDENTIALS: [{ label: 'bench-poll', tokenHash: hashToken(plan.pollToken) }],
    },
    prisma,
    clock: { now: () => new Date(clock.current) },
  });
  const call = async (url: string, token: string, payload?: object, headers = {}) => {
    const r = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(payload && { payload }),
    });
    if (r.statusCode >= 300) throw new Error(`${url} -> ${r.statusCode} ${r.body}`);
    return r.json<Record<string, unknown>>();
  };
  return {
    env,
    prisma,
    app,
    clock,
    call,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

/** Vota a fatia [index, index+step, …] do total, com `concurrency` requisições em paralelo. */
async function vote(plan: Plan, index: number, step: number, concurrency: number) {
  const { call, close } = await startApp(plan);
  const sections = plan.ids.length;
  const total = sections * plan.perSection;
  const auth: number[] = [];
  const ballot: number[] = [];
  let next = index;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let k = next; k < total; k = next) {
        next += step;
        const section = k % sections;
        const id = plan.ids[section] ?? '';
        let t0 = performance.now();
        const { token } = await call(`/elections/${id}/voting-sessions`, plan.pollToken, {
          voterIdentifier: cpf(section * plan.perSection + Math.floor(k / sections)),
        });
        auth.push(performance.now() - t0);
        t0 = performance.now();
        await call(
          '/ballots',
          String(token),
          { electionId: id, choice: { type: 'candidate', number: 13 } },
          { 'idempotency-key': randomUUID() },
        );
        ballot.push(performance.now() - t0);
      }
    }),
  );
  await close();
  return { auth, ballot };
}

// Modo trabalhador: só vota a própria fatia e devolve as latências.
if (process.argv[2] === '--worker') {
  const [, , , planFile = '', index = '0', step = '1', concurrency = '16'] = process.argv;
  const plan = JSON.parse(readFileSync(planFile, 'utf8')) as Plan;
  const result = await vote(plan, Number(index), Number(step), Number(concurrency));
  // Esperar o stdout (um pipe, escrita assíncrona) terminar e SÓ ENTÃO sair: com exit()
  // imediato a saída era cortada; com exit() no callback, o código abaixo seguia executando.
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(result), () => {
      resolve();
    });
  });
  process.exit(0);
}

const [sections = 200, perSection = 100, concurrency = 64, processes = 1] = process.argv
  .slice(2)
  .map(Number);

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl },
  stdio: 'pipe',
});
execFileSync('npx', ['tsx', 'scripts/setup-app-role.ts', 'bench'], { stdio: 'pipe' });

const owner = createPrismaClient(ownerUrl);
const tables = await owner.$queryRaw<{ tablename: string }[]>`
  SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
await owner.$transaction([
  owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate'),
  owner.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  ),
  owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate'),
]);

// Prepara as seções (fora da medição).
const plan: Plan = {
  ids: [],
  perSection,
  now: Date.UTC(2030, 0, 1, 8),
  adminToken: generateToken(),
  pollToken: generateToken(),
};
{
  const setup = await startApp(plan);
  const hash = createVoterIdentifierHasher(setup.env.VOTER_ID_PEPPER);
  for (let s = 0; s < sections; s++) {
    const election = await setup.call('/admin/elections', plan.adminToken, {
      name: `Seção ${s + 1}`,
      startsAt: new Date(plan.now + HOUR).toISOString(),
      endsAt: new Date(plan.now + 10 * HOUR).toISOString(),
    });
    const id = String(election.id);
    plan.ids.push(id);
    await setup.call(`/admin/elections/${id}/candidates`, plan.adminToken, {
      number: 13,
      name: 'A',
    });
    const voterIds = Array.from({ length: perSection }, () => randomUUID());
    const hmacs = Array.from({ length: perSection }, (_, i) => hash(id, cpf(s * perSection + i)));
    await owner.$executeRaw`
      INSERT INTO voters (id, election_id, identifier_hmac)
      SELECT unnest(${voterIds}::uuid[]), ${id}::uuid, unnest(${hmacs}::bytea[])`;
    await setup.call(`/admin/elections/${id}/open`, plan.adminToken);
  }
  await setup.close();
}
plan.now += HOUR;

// Amostragem do PostgreSQL durante a carga.
const waits = new Map<string, number>();
const control = { sampling: true, samples: 0 };
const sampler = (async () => {
  while (control.sampling) {
    const rows = await owner.$queryRaw<{ wait: string; n: bigint }[]>`
      SELECT coalesce(wait_event_type || ':' || wait_event, 'CPU (executando)') AS wait, count(*) AS n
        FROM pg_stat_activity
       WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()
       GROUP BY 1`;
    control.samples++;
    for (const r of rows) waits.set(r.wait, (waits.get(r.wait) ?? 0) + Number(r.n));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
})();

const started = performance.now();
let results: { auth: number[]; ballot: number[] }[];
if (processes <= 1) {
  results = [await vote(plan, 0, 1, concurrency)];
} else {
  const planFile = join(tmpdir(), `urna-bench-plan-${process.pid}.json`);
  writeFileSync(planFile, JSON.stringify(plan));
  const perProcess = Math.max(1, Math.round(concurrency / processes));
  results = await Promise.all(
    Array.from(
      { length: processes },
      (_, i) =>
        new Promise<{ auth: number[]; ballot: number[] }>((resolve, reject) => {
          const child = spawn(
            'npx',
            [
              'tsx',
              'scripts/bench-national.ts',
              '--worker',
              planFile,
              String(i),
              String(processes),
              String(perProcess),
            ],
            { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] },
          );
          let out = '';
          child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
          child.on('exit', (code) => {
            if (code === 0) resolve(JSON.parse(out) as { auth: number[]; ballot: number[] });
            else reject(new Error(`worker ${i} exited with ${code}`));
          });
        }),
    ),
  );
}
const seconds = (performance.now() - started) / 1000;
control.sampling = false;
await sampler;

const total = sections * perSection;
const auth = results.flatMap((r) => r.auth).sort((a, b) => a - b);
const ballot = results.flatMap((r) => r.ballot).sort((a, b) => a - b);
if (auth.length !== total || ballot.length !== total) throw new Error('not every voter voted');
const ballots = await owner.ballot.count();
if (ballots !== total) throw new Error(`expected ${total} ballots, found ${ballots}`);

const fmt = (n: number) => n.toFixed(n < 10 ? 1 : 0);
const throughput = total / seconds;
process.stdout.write(
  [
    `seções: ${sections} · eleitores por seção: ${perSection} · total: ${total} · ` +
      `requisições simultâneas: ${concurrency} · processos da aplicação: ${processes}`,
    `votação: ${seconds.toFixed(1)} s · ${throughput.toFixed(0)} eleitores/s (todos os ${ballots} votos conferidos)`,
    `habilitação p50/p95/p99: ${fmt(percentile(auth, 50))} / ${fmt(percentile(auth, 95))} / ${fmt(percentile(auth, 99))} ms`,
    `voto        p50/p95/p99: ${fmt(percentile(ballot, 50))} / ${fmt(percentile(ballot, 95))} / ${fmt(percentile(ballot, 99))} ms`,
    ``,
    `Onde as conexões ativas do PostgreSQL estavam (média por amostra, ${control.samples} amostras):`,
    ...[...waits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([w, n]) => `  ${(n / control.samples).toFixed(1).padStart(5)}  ${w}`),
    ``,
    `Projeção para 156 milhões de eleitores neste ritmo: ${(156e6 / throughput / 3600).toFixed(1)} h (uma eleição dura 9 h).`,
    ``,
  ].join('\n'),
);
await owner.$disconnect();
