import { z } from 'zod';
import { operatorCredentialsSchema } from '../security/operator-credentials.js';
import { signingKeySchema } from '../security/signing.js';
import { pepperSchema } from '../security/voter-identifier.js';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    ADMIN_CREDENTIALS: operatorCredentialsSchema,
    POLL_WORKER_CREDENTIALS: operatorCredentialsSchema,
    VOTING_SESSION_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    VOTER_ID_PEPPER: pepperSchema,
    SIGNING_PRIVATE_KEY: signingKeySchema,
    /** Requisições por minuto por IP. 0 desliga (só para testes). */
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(100_000).default(300),
  })
  .superRefine((env, ctx) => {
    // Produção não aceita configurações de desenvolvimento.
    if (env.NODE_ENV === 'production') {
      const devLabels = [...env.ADMIN_CREDENTIALS, ...env.POLL_WORKER_CREDENTIALS].filter((c) =>
        c.label.startsWith('dev-'),
      );
      if (devLabels.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['ADMIN_CREDENTIALS'],
          message: 'dev-* credentials in production',
        });
      }
      if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
        ctx.addIssue({
          code: 'custom',
          path: ['LOG_LEVEL'],
          message: 'Verbose logging in production',
        });
      }
      if (env.RATE_LIMIT_PER_MINUTE === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['RATE_LIMIT_PER_MINUTE'],
          message: 'Rate limit disabled in production',
        });
      }
      if (new URL(env.DATABASE_URL).username !== 'urna_app') {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'Must use the least-privilege role',
        });
      }
    }

    // Separação de funções: um mesmo token não pode valer como admin E como mesário.
    const adminHashes = new Set(env.ADMIN_CREDENTIALS.map((c) => c.tokenHash.toString('hex')));
    if (env.POLL_WORKER_CREDENTIALS.some((c) => adminHashes.has(c.tokenHash.toString('hex')))) {
      ctx.addIssue({
        code: 'custom',
        path: ['POLL_WORKER_CREDENTIALS'],
        message: 'A token cannot be both ADMIN and POLL_WORKER',
      });
    }
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
