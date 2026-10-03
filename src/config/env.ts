import { z } from 'zod';
import { adminCredentialsSchema } from '../security/admin-credentials.js';
import { pepperSchema } from '../security/voter-identifier.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  ADMIN_CREDENTIALS: adminCredentialsSchema,
  VOTER_ID_PEPPER: pepperSchema,
});

export type Env = z.infer<typeof envSchema>;

export class InvalidEnvironmentError extends Error {
  override readonly name = 'InvalidEnvironmentError';

  constructor(readonly invalidVariables: readonly string[]) {
    super(`Invalid environment configuration: ${invalidVariables.join(', ')}`);
  }
}

/**
 * Valida variáveis de ambiente na inicialização (fail fast).
 * A mensagem de erro lista só os NOMES das variáveis: valores podem ser segredos.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
  throw new InvalidEnvironmentError(names);
}
