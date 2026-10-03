/**
 * Gera um token de operador (admin ou mesário) e a linha para ADMIN_CREDENTIALS
 * ou POLL_WORKER_CREDENTIALS.
 * Uso: npm run operator:token -- <label>
 * O token aparece só aqui; a configuração guarda apenas o hash.
 */
import { generateToken, hashToken } from '../src/security/tokens.js';

const label = process.argv[2] ?? '';
if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(label)) {
  process.stderr.write('Uso: npm run operator:token -- <label>   (minúsculas, dígitos, . _ -)\n');
  process.exit(1);
}

const token = generateToken();
process.stdout.write(
  [
    `Token (entregue ao operador, não será exibido de novo):`,
    `  ${token}`,
    ``,
    `Adicione ao ADMIN_CREDENTIALS ou ao POLL_WORKER_CREDENTIALS (separado por vírgula):`,
    `  ${label}:${hashToken(token).toString('hex')}`,
    ``,
  ].join('\n'),
);
