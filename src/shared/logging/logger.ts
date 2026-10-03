import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import type { Env } from '../../config/env.js';

export const REDACTED = '[REDACTED]';

/**
 * Segunda linha de defesa: se algum código logar um objeto com estes campos,
 * o valor é substituído. A primeira linha é não logar (ver `serializeRequest`).
 */
export const redactPaths = [
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["idempotency-key"]',
  'idempotencyKey',
  '*.idempotencyKey',
  'voterIdentifier',
  '*.voterIdentifier',
  'choice',
  '*.choice',
  'pepper',
  '*.pepper',
  'secret',
  '*.secret',
  'privateKey',
  '*.privateKey',
  'password',
  '*.password',
];

/**
 * Whitelist do que um log de requisição contém. Ficam de fora, de propósito:
 * - headers (Authorization, Idempotency-Key);
 * - query string (pode carregar dados por engano);
 * - IP do cliente: IP + horário em /voting-sessions e /ballots permitiria correlacionar eleitor e voto.
 */
export function serializeRequest(request: FastifyRequest): Record<string, string> {
  return {
    id: request.id,
    method: request.method,
    url: request.url.split('?')[0] ?? '',
  };
}

export type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

export function buildLoggerOptions(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): LoggerOptions {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: { paths: redactPaths, censor: REDACTED },
    serializers: { req: serializeRequest },
  };

  if (env.NODE_ENV === 'development') {
    options.transport = { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } };
  }
  return options;
}
