/**
 * TypeScript × Rust: o MESMO cenário, via HTTP real, contra as duas implementações.
 *
 * Uso: npm run bench:compare -- [seções] [eleitores por seção] [simultâneas] [conexões] [processos TS]
 *      ex.: npm run bench:compare -- 200 100 64 20 4
 * [processos TS] > 1 sobe N instâncias Node (cada gerador fala com uma, como atrás de um
 * balanceador) dividindo entre elas as [conexões] com o banco: o total é sempre o mesmo do Rust.
 *
 * Para cada backend: zera o banco *_bench, sobe o servidor (TS compilado com `node dist/server.js`;
 * Rust em release), mede o tempo até ficar pronto e a memória ociosa, prepara as seções (fora da
 * medição), aquece, e então mede:
 *   1. latência sem concorrência (um eleitor por vez): o custo de cada requisição;
 *   2. carga nacional: muitas seções votando ao mesmo tempo (vazão, p50/p95/p99, CPU e memória).
 * A carga sai de processos geradores SEPARADOS (Node), para o gerador não disputar CPU com o
 * servidor medido; o script informa a CPU dos geradores para mostrar que não foram o gargalo.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { createPrismaClient } from '../src/database/client.js';
import { loadEnv } from '../src/config/env.js';
import { createVoterIdentifierHasher } from '../src/security/voter-identifier.js';

interface Plan {
  urls: string[];
  ids: string[];
  perSection: number;
  firstVoter: number;
  adminToken: string;
  pollToken: string;
}

interface Latencies {
  auth: number[];
  ballot: number[];
  errors: number;
}

const env = readFileSync('.env', 'utf8');
const [ADMIN = '', POLL = ''] = [...env.matchAll(/é: (\S+)/g)].map((m) => m[1] ?? '');

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

async function post(
  url: string,
  token: string,
  body?: object,
  headers: Record<string, string> = {},
) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body && { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${url} -> ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Vota a fatia [index, index+step, …] com `concurrency` eleitores em paralelo. */
async function vote(
  plan: Plan,
  index: number,
  step: number,
  concurrency: number,
): Promise<Latencies> {
  const sections = plan.ids.length;
  const total = sections * plan.perSection;
  const out: Latencies = { auth: [], ballot: [], errors: 0 };
  const url = plan.urls[index % plan.urls.length] ?? '';
  let next = index;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let k = next; k < total; k = next) {
        next += step;
        const section = k % sections;
        const id = plan.ids[section] ?? '';
        try {
          let t0 = performance.now();
          const { token } = await post(`${url}/elections/${id}/voting-sessions`, plan.pollToken, {
            voterIdentifier: cpf(
              plan.firstVoter + section * plan.perSection + Math.floor(k / sections),
            ),
          });
          out.auth.push(performance.now() - t0);
          t0 = performance.now();
          await post(
            `${url}/ballots`,
            String(token),
            { electionId: id, choice: { type: 'candidate', number: 13 } },
            { 'idempotency-key': randomUUID() },
          );
          out.ballot.push(performance.now() - t0);
        } catch {
          out.errors++;
        }
      }
    }),
  );
  return out;
}

// Modo gerador: lê o plano, avisa "pronto", espera "vai" e devolve as latências + CPU usada.
if (process.argv[2] === '--gen') {
  const [, , , planFile = '', index = '0', step = '1', concurrency = '1'] = process.argv;
  const plan = JSON.parse(readFileSync(planFile, 'utf8')) as Plan;
  process.stdout.write('ready\n');
  await new Promise<void>((resolve) =>
    createInterface({ input: process.stdin }).once('line', () => {
      resolve();
    }),
  );
  const cpu0 = process.cpuUsage();
  const result = await vote(plan, Number(index), Number(step), Number(concurrency));
  const cpu = process.cpuUsage(cpu0);
  await new Promise<void>((resolve) => {
    process.stdout.write(
      JSON.stringify({ ...result, cpuMs: (cpu.user + cpu.system) / 1000 }) + '\n',
      () => {
        resolve();
      },
    );
  });
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------

const [sections = 100, perSection = 100, concurrency = 64, poolSize = 20, tsProcesses = 1] =
  process.argv.slice(2).map(Number);
const GENERATORS = Math.min(8, Math.max(1, Math.ceil(concurrency / 16)));
const appUrl = process.env.BENCH_DATABASE_URL ?? '';
const ownerUrl = process.env.BENCH_MIGRATION_DATABASE_URL ?? '';
if (
  !new URL(appUrl).pathname.endsWith('_bench') ||
  !new URL(ownerUrl).pathname.endsWith('_bench')
) {
  throw new Error('BENCH_* must point to a *_bench database');
}
const hash = createVoterIdentifierHasher(
  loadEnv({ ...process.env, DATABASE_URL: appUrl }).VOTER_ID_PEPPER,
);
const owner = createPrismaClient(ownerUrl);
const CLK_TCK = 100;
const PAGE = 4096;

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl },
  stdio: 'pipe',
});
execFileSync('npx', ['tsx', 'scripts/setup-app-role.ts', 'bench'], { stdio: 'pipe' });
process.stdout.write('compilando as duas versões…\n');
execFileSync('npm', ['run', '-s', 'build'], { stdio: 'pipe' });
execFileSync('npm', ['run', '-s', 'rust:build'], { stdio: 'pipe' });

async function resetDatabase() {
  const tables = await owner.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await owner.$transaction([
    owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate'),
    owner.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    ),
    owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate'),
  ]);
  await owner.$executeRawUnsafe('VACUUM ANALYZE');
}

/** CPU (ms) e memória residente (MB) do processo, lidos de /proc. */
function cpuMs(pid: number): number {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
  return ((Number(fields[11]) + Number(fields[12])) * 1000) / CLK_TCK;
}
function rssMb(pid: number): number {
  return (Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * PAGE) / 2 ** 20;
}

async function startServer(
  name: 'typescript' | 'rust',
  index: number,
  pool: number,
): Promise<{ child: ChildProcess; url: string; readyMs: number }> {
  const port = (name === 'rust' ? 3300 : 3200) + index;
  const serverEnv = {
    ...process.env,
    DATABASE_URL: appUrl,
    DATABASE_POOL_SIZE: String(pool),
    RATE_LIMIT_PER_MINUTE: '0',
    LOG_LEVEL: 'warn',
    NODE_ENV: 'development',
    PORT: String(port),
    RUST_PORT: String(port),
  };
  const started = performance.now();
  const child =
    name === 'rust'
      ? spawn('rust/target/release/urna-server', [], {
          env: serverEnv,
          stdio: ['ignore', 'ignore', 'inherit'],
        })
      : spawn(process.execPath, ['dist/server.js'], {
          env: serverEnv,
          stdio: ['ignore', 'ignore', 'inherit'],
        });
  const url = `http://127.0.0.1:${port}`;
  for (;;) {
    try {
      if ((await fetch(`${url}/health/ready`)).ok) break;
    } catch {
      // subindo
    }
    if (child.exitCode !== null) throw new Error(`${name} server exited`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return { child, url, readyMs: performance.now() - started };
}

async function seed(url: string, count: number, firstVoter: number): Promise<string[]> {
  const ids: string[] = [];
  for (let s = 0; s < count; s++) {
    const election = await post(`${url}/admin/elections`, ADMIN, {
      name: `Seção ${s + 1}`,
      startsAt: new Date(Date.now() + 1000).toISOString(),
      endsAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    });
    const id = String(election.id);
    ids.push(id);
    await post(`${url}/admin/elections/${id}/candidates`, ADMIN, { number: 13, name: 'A' });
    const voterIds = Array.from({ length: perSection }, () => randomUUID());
    const hmacs = Array.from({ length: perSection }, (_, i) =>
      hash(id, cpf(firstVoter + s * perSection + i)),
    );
    await owner.$executeRaw`
      INSERT INTO voters (id, election_id, identifier_hmac)
      SELECT unnest(${voterIds}::uuid[]), ${id}::uuid, unnest(${hmacs}::bytea[])`;
    await post(`${url}/admin/elections/${id}/open`, ADMIN);
  }
  await new Promise((r) => setTimeout(r, 1100)); // todas as janelas já começaram
  return ids;
}

/** Roda um plano em N geradores; mede a janela [vai → último resultado]. */
const sumOver = (pids: number[], read: (pid: number) => number) =>
  pids.reduce((a, pid) => a + read(pid), 0);

async function load(plan: Plan, totalConcurrency: number, generators: number, pids: number[]) {
  const planFile = join(tmpdir(), `urna-bench-compare-${process.pid}.json`);
  writeFileSync(planFile, JSON.stringify(plan));
  const per = Math.max(1, Math.round(totalConcurrency / generators));
  const children = Array.from({ length: generators }, (_, i) =>
    spawn(
      'npx',
      [
        'tsx',
        'scripts/bench-compare.ts',
        '--gen',
        planFile,
        String(i),
        String(generators),
        String(per),
      ],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    ),
  );
  const lines = children.map((child) => {
    const rl = createInterface({ input: child.stdout });
    const queue: string[] = [];
    const waiters: ((line: string) => void)[] = [];
    rl.on('line', (line) => {
      const w = waiters.shift();
      if (w) w(line);
      else queue.push(line);
    });
    return () =>
      new Promise<string>((resolve) => {
        if (queue.length) resolve(queue.shift() ?? '');
        else waiters.push(resolve);
      });
  });
  await Promise.all(lines.map((next) => next())); // "ready"

  let peakRss = sumOver(pids, rssMb);
  const sampler = setInterval(() => (peakRss = Math.max(peakRss, sumOver(pids, rssMb))), 50);
  const cpu0 = sumOver(pids, cpuMs);
  const t0 = performance.now();
  for (const child of children) child.stdin.write('go\n');
  const results = (await Promise.all(lines.map((next) => next()))).map(
    (line) => JSON.parse(line) as Latencies & { cpuMs: number },
  );
  const seconds = (performance.now() - t0) / 1000;
  const serverCpu = sumOver(pids, cpuMs) - cpu0;
  clearInterval(sampler);
  return {
    seconds,
    auth: results.flatMap((r) => r.auth).sort((a, b) => a - b),
    ballot: results.flatMap((r) => r.ballot).sort((a, b) => a - b),
    errors: results.reduce((a, r) => a + r.errors, 0),
    serverCpuPct: serverCpu / 10 / seconds,
    generatorCpuPct: results.reduce((a, r) => a + r.cpuMs, 0) / 10 / seconds,
    peakRss,
  };
}

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

async function run(name: 'typescript' | 'rust') {
  await resetDatabase();
  const processes = name === 'typescript' ? tsProcesses : 1;
  const servers = await Promise.all(
    Array.from({ length: processes }, (_, i) =>
      startServer(name, i, Math.ceil(poolSize / processes)),
    ),
  );
  const readyMs = Math.max(...servers.map((x) => x.readyMs));
  const urls = servers.map((x) => x.url);
  const url = urls[0] ?? '';
  const pid = servers.map((x) => x.child.pid ?? 0);
  // Cada instância precisa de pelo menos um gerador.
  const generators = Math.ceil(GENERATORS / processes) * processes;
  await new Promise((r) => setTimeout(r, 500));
  const idleRss = sumOver(pid, rssMb);
  process.stdout.write(
    `\n[${name}] pronto em ${readyMs.toFixed(0)} ms · preparando ${sections} seções…\n`,
  );

  const base = { urls, perSection, adminToken: ADMIN, pollToken: POLL };
  // Aquecimento (JIT do V8, pools, caches do PostgreSQL), fora da medição.
  const warm = Math.max(4, Math.ceil(sections / 10));
  let voter = 0;
  const warmIds = await seed(url, warm, voter);
  await load({ ...base, ids: warmIds, firstVoter: voter }, concurrency, generators, pid);
  voter += warm * perSection;

  // 1) Latência sem concorrência: 2 seções, um eleitor por vez.
  const serialIds = await seed(url, 2, voter);
  const serial = await load({ ...base, ids: serialIds, firstVoter: voter }, 1, 1, pid);
  voter += 2 * perSection;

  // 2) Carga nacional.
  const ids = await seed(url, sections, voter);
  process.stdout.write(
    `[${name}] votando: ${sections * perSection} eleitores, ${concurrency} simultâneos…\n`,
  );
  const national = await load({ ...base, ids, firstVoter: voter }, concurrency, generators, pid);

  const expected = (warm + 2 + sections) * perSection;
  const ballots = await owner.ballot.count();
  await Promise.all(
    servers.map(({ child }) => {
      child.kill('SIGTERM');
      return new Promise((r) => child.once('exit', r));
    }),
  );
  if (ballots !== expected || national.errors + serial.errors > 0) {
    throw new Error(
      `${name}: ${ballots}/${expected} ballots, ${national.errors + serial.errors} errors`,
    );
  }
  return { name, readyMs, idleRss, serial, national, ballots, generators };
}

const results = [];
for (const name of ['typescript', 'rust'] as const) results.push(await run(name));

// Dados estáticos: tamanho do que é implantado, dependências, linhas de código.
const sh = (cmd: string) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }).trim();
const nodeBin = statSync(process.execPath).size / 2 ** 20;
const prodDeps = sh(
  'npm ls --omit=dev --all --parseable 2>/dev/null | tail -n +2 | sort -u | wc -l',
);
const prodDepsMb =
  Number(
    sh(
      `npm ls --omit=dev --all --parseable 2>/dev/null | tail -n +2 | grep -vE 'node_modules/.+/node_modules/' | sort -u | xargs du -sk 2>/dev/null | awk '{s+=$1} END {print s}'`,
    ),
  ) / 1024;
const distMb = Number(sh('du -sk dist | cut -f1')) / 1024;
const rustBin = statSync('rust/target/release/urna-server').size / 2 ** 20;
const crates = sh(
  `${process.env.HOME ?? ''}/.cargo/bin/cargo tree --manifest-path rust/Cargo.toml -e normal --prefix none 2>/dev/null | sed 's/ (\\*)//' | sort -u | wc -l`,
);
const tsLoc = sh("find src -name '*.ts' -not -path 'src/generated/*' | xargs cat | wc -l");
const rsLoc = sh("find rust/src -name '*.rs' | xargs cat | wc -l");

const [ts, rs] = results as [(typeof results)[0], (typeof results)[0]];
const f = (n: number, d = 1) => n.toFixed(d);
const ratio = (a: number, b: number) => `${f(a / b, 1)}×`;
const lat = (s: number[]) => `${f(pct(s, 50))} / ${f(pct(s, 95))} / ${f(pct(s, 99))}`;
const tput = (r: typeof ts) => (sections * perSection) / r.national.seconds;
const rows: [string, string, string, string][] = [
  [
    'Vazão (eleitores/s, habilitação + voto)',
    f(tput(ts), 0),
    f(tput(rs), 0),
    ratio(tput(rs), tput(ts)),
  ],
  ['Habilitação p50/p95/p99 sob carga (ms)', lat(ts.national.auth), lat(rs.national.auth), ''],
  ['Voto p50/p95/p99 sob carga (ms)', lat(ts.national.ballot), lat(rs.national.ballot), ''],
  [
    'Habilitação p50 sem concorrência (ms)',
    f(pct(ts.serial.auth, 50), 2),
    f(pct(rs.serial.auth, 50), 2),
    ratio(pct(ts.serial.auth, 50), pct(rs.serial.auth, 50)),
  ],
  [
    'Voto p50 sem concorrência (ms)',
    f(pct(ts.serial.ballot, 50), 2),
    f(pct(rs.serial.ballot, 50), 2),
    ratio(pct(ts.serial.ballot, 50), pct(rs.serial.ballot, 50)),
  ],
  [
    'CPU do servidor sob carga (% de 1 núcleo)',
    f(ts.national.serverCpuPct, 0),
    f(rs.national.serverCpuPct, 0),
    '',
  ],
  [
    'CPU por eleitor (ms)',
    f((ts.national.serverCpuPct * 10 * ts.national.seconds) / (sections * perSection), 2),
    f((rs.national.serverCpuPct * 10 * rs.national.seconds) / (sections * perSection), 2),
    '',
  ],
  ['Memória ociosa (MB RSS)', f(ts.idleRss, 0), f(rs.idleRss, 0), ratio(ts.idleRss, rs.idleRss)],
  [
    'Memória de pico sob carga (MB RSS)',
    f(ts.national.peakRss, 0),
    f(rs.national.peakRss, 0),
    ratio(ts.national.peakRss, rs.national.peakRss),
  ],
  [
    'Tempo até ficar pronto (ms)',
    f(ts.readyMs, 0),
    f(rs.readyMs, 0),
    ratio(ts.readyMs, rs.readyMs),
  ],
  [
    'O que se implanta (MB)',
    `${f(nodeBin + prodDepsMb + distMb, 0)} (node ${f(nodeBin, 0)} + deps ${f(prodDepsMb, 0)} + código ${f(distMb, 1)})`,
    f(rustBin, 1),
    '',
  ],
  ['Dependências de produção (pacotes/crates)', prodDeps, crates, ''],
  ['Linhas de código do backend', tsLoc, rsLoc, ''],
];
const cell = (s: string, w: number) => s.padEnd(w);
const widths = [44, 34, 22, 8];
process.stdout.write(
  [
    '',
    `Cenário: ${sections} seções × ${perSection} eleitores = ${sections * perSection} (+ aquecimento) · ` +
      `${concurrency} requisições simultâneas · ${poolSize} conexões com o banco no total · ` +
      `${ts.generators}/${rs.generators} geradores`,
    `Todos os votos conferidos no banco (${ts.ballots} e ${rs.ballots}). CPU dos geradores: ` +
      `${f(ts.national.generatorCpuPct, 0)}% / ${f(rs.national.generatorCpuPct, 0)}% de 1 núcleo.`,
    '',
    [
      '',
      `TypeScript (${tsProcesses} processo${tsProcesses > 1 ? 's' : ''} Node)`,
      'Rust (1 processo)',
      'Rust ×',
    ]
      .map((s, i) => cell(s, widths[i] ?? 0))
      .join(' │ '),
    ...rows.map((r) => r.map((s, i) => cell(s, widths[i] ?? 0)).join(' │ ')),
    '',
  ].join('\n'),
);
await owner.$disconnect();
