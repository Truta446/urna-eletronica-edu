/**
 * Verifica um resultado publicado, sem acesso ao banco.
 * Uso: npm run verify:result -- <baseUrl> <electionId>
 * Ex.: npm run verify:result -- http://127.0.0.1:3000 6f1c...
 */
import {
  plainPublishedDecoder,
  publishedBallotsSchema,
  publishedTallySchema,
  verifyPublishedResult,
} from '../src/verifier/verify-published.js';

const [baseUrl, electionId] = process.argv.slice(2);
if (!baseUrl || !electionId) {
  process.stderr.write('Uso: npm run verify:result -- <baseUrl> <electionId>\n');
  process.exit(1);
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const tally = publishedTallySchema.parse(await fetchJson(`/elections/${electionId}/tally`));
const ballots = publishedBallotsSchema.parse(await fetchJson(`/elections/${electionId}/ballots`));
const report = await verifyPublishedResult(tally, ballots, plainPublishedDecoder);
for (const { check, ok } of report.checks) process.stdout.write(`${ok ? '✅' : '❌'} ${check}\n`);
process.stdout.write(`\n${report.valid ? 'RESULTADO VERIFICADO' : 'RESULTADO NÃO CONFERE'}\n`);
process.exit(report.valid ? 0 : 2);
