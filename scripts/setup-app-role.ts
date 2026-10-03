/**
 * Habilita LOGIN e define a senha da role da aplicação a partir de DATABASE_URL, conectando
 * como dono do schema (MIGRATION_DATABASE_URL). Roda dentro de `npm run db:migrate`.
 * Para os testes: TEST_* (as duas URLs do banco de teste).
 */
import pg from 'pg';

try {
  process.loadEnvFile('.env');
} catch {
  // sem .env: só o ambiente
}

const target = process.argv[2] === 'test' ? 'TEST_' : '';
const appUrl = process.env[`${target}DATABASE_URL`];
const ownerUrl = process.env[`${target}MIGRATION_DATABASE_URL`];
if (!appUrl || !ownerUrl) {
  process.stderr.write(
    `${target}DATABASE_URL e ${target}MIGRATION_DATABASE_URL são obrigatórias\n`,
  );
  process.exit(1);
}

const app = new URL(appUrl);
if (app.username !== 'urna_app') {
  process.stderr.write('DATABASE_URL deve usar a role de menor privilégio "urna_app"\n');
  process.exit(1);
}

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
  const password = client.escapeLiteral(decodeURIComponent(app.password));
  await client.query(`ALTER ROLE "urna_app" WITH LOGIN PASSWORD ${password}`);
  process.stdout.write('role urna_app: LOGIN habilitado\n');
} finally {
  await client.end();
}
