/**
 * Demonstração de uma eleição COMPLETA (v2, cifrada), passo a passo, em segundos.
 * Uso: docker compose up -d && npm run db:migrate && npm run demo
 *
 * Roda a aplicação dentro deste processo (sem abrir porta) contra o banco de DESENVOLVIMENTO,
 * com um relógio simulado para não esperar horários reais. Cria credenciais de operador
 * próprias, só para esta execução.
 */
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClient } from '../src/database/client.js';
import { createTrusteeDecoder } from '../src/modules/tally/application/encrypted-ballots.js';
import { generateElectionKeyPair } from '../src/security/ballot-encryption.js';
import { generateToken, hashToken } from '../src/security/tokens.js';
import { splitKey } from '../src/security/trustees.js';
import {
  publishedBallotsSchema,
  publishedTallySchema,
  verifyPublishedResult,
} from '../src/verifier/verify-published.js';
import { randomCpf } from '../test/helpers/cpf.js';

const HOUR = 3_600_000;
let current = Date.now();
const clock = { now: () => new Date(current) };

const say = (text: string) => process.stdout.write(`${text}\n`);
const step = (n: number, text: string) => say(`\n\x1b[1m${n}. ${text}\x1b[0m`);

const env = loadEnv();
const adminToken = generateToken();
const pollWorkerToken = generateToken();
const prisma = createPrismaClient(env.DATABASE_URL);
const app = await buildApp({
  env: {
    ...env,
    LOG_LEVEL: 'silent',
    RATE_LIMIT_PER_MINUTE: 0,
    ADMIN_CREDENTIALS: [{ label: 'demo-admin', tokenHash: hashToken(adminToken) }],
    POLL_WORKER_CREDENTIALS: [{ label: 'demo-mesario', tokenHash: hashToken(pollWorkerToken) }],
  },
  prisma,
  clock,
});

async function call(
  method: 'GET' | 'POST',
  url: string,
  token?: string,
  payload?: object,
  extra = {},
) {
  const response = await app.inject({
    method,
    url,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...extra },
    ...(payload && { payload }),
  });
  return {
    status: response.statusCode,
    body: response.json<Record<string, unknown>>(),
    headers: response.headers,
  };
}

try {
  step(
    1,
    'Cerimônia de chaves: par HPKE da eleição, chave privada dividida entre 3 trustees (limiar 2)',
  );
  const keys = await generateElectionKeyPair();
  const shares = await splitKey(keys.privateKey, 3, 2);
  keys.privateKey.fill(0);
  say(`   chave pública: ${keys.publicKey.toString('base64url')}`);
  say(`   ${shares.length} partes entregues; o servidor só conhece a chave pública`);

  step(2, 'Admin cria a eleição (cifrada), 2 candidatos e 5 eleitores');
  const created = await call('POST', '/admin/elections', adminToken, {
    name: 'Demonstração',
    startsAt: new Date(current + HOUR).toISOString(),
    endsAt: new Date(current + 9 * HOUR).toISOString(),
    encryptionPublicKey: keys.publicKey.toString('base64url'),
  });
  const id = String(created.body.id);
  say(`   eleição ${id} · ${String(created.body.ballotEncryption)}`);
  for (const [number, name] of [
    [13, 'Ana'],
    [45, 'Bruno'],
  ] as const) {
    await call('POST', `/admin/elections/${id}/candidates`, adminToken, { number, name });
  }
  const cpfs = Array.from({ length: 5 }, () => randomCpf());
  for (const cpf of cpfs)
    await call('POST', `/admin/elections/${id}/voters`, adminToken, { voterIdentifier: cpf });
  say('   CPFs guardados só como HMAC com chave derivada por eleição');

  step(3, 'Abertura e início da votação (relógio avança até startsAt)');
  say(`   open → ${(await call('POST', `/admin/elections/${id}/open`, adminToken)).status}`);
  current += HOUR;

  step(4, 'Mesário habilita cada eleitor; cada eleitor vota com seu token de uso único');
  const choices = [
    { type: 'candidate', number: 13 },
    { type: 'candidate', number: 13 },
    { type: 'candidate', number: 45 },
    { type: 'blank' },
  ];
  for (const [i, cpf] of cpfs.entries()) {
    const auth = await call('POST', `/elections/${id}/voting-sessions`, pollWorkerToken, {
      voterIdentifier: cpf,
    });
    if (i === 4) {
      say('   eleitor 5: habilitado, mas não vota (aparece como "habilitado sem voto")');
      break;
    }
    const key = randomUUID();
    const vote = { electionId: id, choice: choices[i] };
    const cast = await call('POST', '/ballots', String(auth.body.token), vote, {
      'idempotency-key': key,
    });
    say(
      `   eleitor ${i + 1}: habilitado (${auth.status}), voto ${cast.status} ${JSON.stringify(cast.body)}`,
    );
    if (i === 0) {
      const retry = await call('POST', '/ballots', String(auth.body.token), vote, {
        'idempotency-key': key,
      });
      const reuse = await call('POST', '/ballots', String(auth.body.token), vote, {
        'idempotency-key': randomUUID(),
      });
      say(
        `     retry (mesma Idempotency-Key): ${retry.status}, replayed=${String(retry.headers['idempotent-replayed'])}`,
      );
      say(`     reuso do token: ${reuse.status} ${JSON.stringify(reuse.body)}`);
      const again = await call('POST', `/elections/${id}/voting-sessions`, pollWorkerToken, {
        voterIdentifier: cpf,
      });
      say(`     habilitar o mesmo eleitor de novo: ${again.status}`);
    }
  }
  const stored = await prisma.ballot.findFirstOrThrow({ where: { electionId: id } });
  say(
    `   no banco, um voto: kind=${String(stored.kind)} candidate=${String(stored.candidateId)} ciphertext=${stored.ciphertext?.length ?? 0} bytes`,
  );

  step(5, 'Fechamento (relógio avança até endsAt): urna lacrada e assinada');
  current += 8 * HOUR;
  say(`   close → ${(await call('POST', `/admin/elections/${id}/close`, adminToken)).status}`);
  const tallyBefore = await call('GET', `/elections/${id}/tally`);
  say(`   resultado público antes da apuração: ${tallyBefore.status} (não existe parcial)`);

  step(6, 'Apuração com as partes dos trustees');
  const one = await call('POST', `/admin/elections/${id}/tally`, adminToken, {
    trusteeShares: [shares[0]],
  });
  say(`   com 1 parte: ${one.status} ${JSON.stringify(one.body)}`);
  const tally = await call('POST', `/admin/elections/${id}/tally`, adminToken, {
    trusteeShares: [shares[0], shares[2]],
  });
  const result = publishedTallySchema.parse(tally.body);
  say(`   com 2 partes: ${tally.status}`);
  for (const c of result.result.candidates) say(`     ${c.number} ${c.name}: ${c.votes}`);
  say(
    `     branco: ${result.result.blank} · nulo: ${result.result.null} · total: ${result.result.totalBallots}`,
  );

  step(7, 'Verificação da cadeia de auditoria e verificação independente do resultado');
  const chain = await call('GET', '/admin/audit/verify', adminToken);
  say(`   cadeia de auditoria: ${JSON.stringify(chain.body)}`);
  const ballots = publishedBallotsSchema.parse(
    (await call('GET', `/elections/${id}/ballots`)).body,
  );
  const report = await verifyPublishedResult(
    result,
    ballots,
    createTrusteeDecoder(Buffer.from(result.decryptionKey ?? '', 'base64url')),
  );
  for (const { check, ok } of report.checks) say(`   ${ok ? '✅' : '❌'} ${check}`);
  say(`\n${report.valid ? 'RESULTADO VERIFICADO' : 'RESULTADO NÃO CONFERE'}`);
} finally {
  await app.close();
  await prisma.$disconnect();
}
