import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { PrismaClient } from './database/client.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerErrorHandling } from './shared/errors/error-handler.js';
import { buildLoggerOptions } from './shared/logging/logger.js';

export interface AppDependencies {
  env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>;
  prisma: PrismaClient;
  /** Destino alternativo dos logs; usado pelos testes para inspecionar o que é logado. */
  logStream?: NodeJS.WritableStream;
}

const BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Monta a aplicação sem abrir porta. Quem cria as dependências (server.ts ou testes)
 * é responsável por encerrá-las.
 */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const loggerOptions = buildLoggerOptions(deps.env);

  const app = Fastify({
    logger: deps.logStream ? { ...loggerOptions, stream: deps.logStream } : loggerOptions,
    bodyLimit: BODY_LIMIT_BYTES,
    // Nunca reaproveitar um request id enviado pelo cliente.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: false,
  });

  registerErrorHandling(app);
  registerHealthRoutes(app, deps.prisma);

  return app;
}
