/**
 * Benchmark do fluxo de votação, medindo como o custo cresce com o tamanho da eleição.
 * Uso: npm run bench -- [eleitores...]        ex.: npm run bench -- 1000 10000 50000
 *
 * - Banco PRÓPRIO (BENCH_*, nome terminando em _bench), truncado a cada cenário.
 * - Eleitores cadastrados em massa direto no banco (o cadastro não é o que queremos medir).
 * - Habilitação e voto pela API real (Fastify + Prisma + PostgreSQL), com concorrência,
 *   dentro deste processo (sem rede: mede aplicação + banco). Relógio simulado.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClient, type PrismaClient } from '../src/database/client.js';
import { createVoterIdentifierHasher } from '../src/security/voter-identifier.js';
import { generateToken, hashToken } from '../src/security/tokens.js';
import {
  verifyPublishedResult,
  publishedBallotsSchema,
  publishedTallySchema,
} from '../src/verifier/verify-published.js';

const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 16);
const sizes = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0);
const SIZES = sizes.length > 0 ? sizes : [1_000, 10_000, 50_000];
const HOUR = 3_600_000;

function requireBenchUrl(name: string): string {
  const url = process.env[name];
  if (!url || !new URL(url).pathname.endsWith('_bench'))
    throw new Error(`${name} must point to a *_bench database`);
  return url;
}

const appUrl = requireBenchUrl('BENCH_DATABASE_URL');
const ownerUrl = requireBenchUrl('BENCH_MIGRATION_DATABASE_URL');
execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl },
  stdio: 'pipe',
});
execFileSync('npx', ['tsx', 'scripts/setup-app-role.ts', 'bench'], { stdio: 'pipe' });

/** CPFs válidos, únicos e determinísticos (aleatórios colidiriam em ~50 mil). */
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

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0));

async function reset(owner: PrismaClient) {
  const tables = await owner.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map(({ tablename }) => `"public"."${tablename}"`).join(', ');
  await owner.$transaction([
    owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate'),
    owner.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`),
    owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate'),
  ]);
}

async function runScenario(voters: number) {
  const env = loadEnv({ ...process.env, DATABASE_URL: appUrl });
  const owner = createPrismaClient(ownerUrl);
  const prisma = createPrismaClient(appUrl);
  await reset(owner);

  let now = Date.UTC(2030, 0, 1, 12);
  const adminToken = generateToken();
  const pollToken = generateToken();
  const app = await buildApp({
    env: {
      ...env,
      LOG_LEVEL: 'silent',
      RATE_LIMIT_PER_MINUTE: 0,
      ADMIN_CREDENTIALS: [{ label: 'bench-admin', tokenHash: hashToken(adminToken) }],
      POLL_WORKER_CREDENTIALS: [{ label: 'bench-poll', tokenHash: hashToken(pollToken) }],
    },
    prisma,
    clock: { now: () => new Date(now) },
  });
  const call = async (
    method: 'GET' | 'POST',
    url: string,
    token: string,
    payload?: object,
    headers = {},
  ) => {
    const r = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(payload && { payload }),
    });
    if (r.statusCode >= 300) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body}`);
    return r.json<Record<string, unknown>>();
  };

  try {
    const election = await call('POST', '/admin/elections', adminToken, {
      name: `Bench ${voters}`,
      startsAt: new Date(now + HOUR).toISOString(),
      endsAt: new Date(now + 24 * HOUR).toISOString(),
    });
    const id = String(election.id);
    for (const number of [13, 45])
      await call('POST', `/admin/elections/${id}/candidates`, adminToken, {
        number,
        name: `C${number}`,
      });

    // Cadastro em massa (fora da medição).
    const hash = createVoterIdentifierHasher(env.VOTER_ID_PEPPER);
    for (let start = 0; start < voters; start += 5_000) {
      const ids: string[] = [];
      const hmacs: Buffer[] = [];
      for (let i = start; i < Math.min(voters, start + 5_000); i++) {
        ids.push(randomUUID());
        hmacs.push(hash(id, cpf(i)));
      }
      await owner.$executeRaw`
        INSERT INTO voters (id, election_id, identifier_hmac)
        SELECT unnest(${ids}::uuid[]), ${id}::uuid, unnest(${hmacs}::bytea[])`;
    }
    await call('POST', `/admin/elections/${id}/open`, adminToken);
    now += HOUR;

    // Votação: cada "worker" pega o próximo eleitor, habilita e vota.
    const auth: { i: number; ms: number }[] = [];
    const vote: { i: number; ms: number }[] = [];
    let next = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let i = next++; i < voters; i = next++) {
          let t0 = performance.now();
          const { token } = await call('POST', `/elections/${id}/voting-sessions`, pollToken, {
            voterIdentifier: cpf(i),
          });
          auth.push({ i, ms: performance.now() - t0 });
          t0 = performance.now();
          await call(
            'POST',
            '/ballots',
            String(token),
            {
              electionId: id,
              choice: i % 3 ? { type: 'candidate', number: i % 2 ? 13 : 45 } : { type: 'blank' },
            },
            { 'idempotency-key': randomUUID() },
          );
          vote.push({ i, ms: performance.now() - t0 });
        }
      }),
    );
    const votingSeconds = (performance.now() - started) / 1000;

    now += 24 * HOUR;
    let t0 = performance.now();
    await call('POST', `/admin/elections/${id}/close`, adminToken);
    const closeMs = performance.now() - t0;

    t0 = performance.now();
    const tally = publishedTallySchema.parse(
      await call('POST', `/admin/elections/${id}/tally`, adminToken),
    );
    const tallyMs = performance.now() - t0;

    t0 = performance.now();
    const ballots = publishedBallotsSchema.parse(
      (await app.inject({ method: 'GET', url: `/elections/${id}/ballots` })).json(),
    );
    const report = await verifyPublishedResult(tally, ballots);
    const verifyMs = performance.now() - t0;
    if (!report.valid || tally.result.totalBallots !== voters)
      throw new Error('verification failed');

    // Latência por faixa de preenchimento da eleição (mostra se o custo cresce com o tamanho).
    const deciles = Array.from({ length: 5 }, (_, d) => {
      const lo = (d * voters) / 5;
      const hi = ((d + 1) * voters) / 5;
      const a = auth
        .filter((x) => x.i >= lo && x.i < hi)
        .map((x) => x.ms)
        .sort((x, y) => x - y);
      const v = vote
        .filter((x) => x.i >= lo && x.i < hi)
        .map((x) => x.ms)
        .sort((x, y) => x - y);
      return {
        band: `${d * 20}-${(d + 1) * 20}%`,
        authP50: percentile(a, 50),
        authP95: percentile(a, 95),
        voteP50: percentile(v, 50),
        voteP95: percentile(v, 95),
      };
    });
    return {
      voters,
      votingSeconds,
      throughput: voters / votingSeconds,
      closeMs,
      tallyMs,
      verifyMs,
      deciles,
    };
  } finally {
    await app.close();
    await prisma.$disconnect();
    await owner.$disconnect();
  }
}

process.stdout.write(`concorrência: ${CONCURRENCY} · cenários: ${SIZES.join(', ')} eleitores\n`);
for (const size of SIZES) {
  const r = await runScenario(size);
  process.stdout.write(
    [
      ``,
      `## ${r.voters.toLocaleString('pt-BR')} eleitores`,
      `votação: ${r.votingSeconds.toFixed(1)} s · ${r.throughput.toFixed(0)} eleitores/s (habilitação + voto)`,
      `fechamento (lacre): ${fmt(r.closeMs)} ms · apuração: ${fmt(r.tallyMs)} ms · verificação independente: ${fmt(r.verifyMs)} ms`,
      `| eleição preenchida | habilitação p50 | p95 | voto p50 | p95 |`,
      `|---|---|---|---|---|`,
      ...r.deciles.map(
        (d) =>
          `| ${d.band} | ${fmt(d.authP50)} ms | ${fmt(d.authP95)} ms | ${fmt(d.voteP50)} ms | ${fmt(d.voteP95)} ms |`,
      ),
      ``,
    ].join('\n'),
  );
}
