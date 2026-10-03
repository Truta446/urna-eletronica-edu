import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { PrismaClient } from './database/client.js';
import { createAuthorizationService } from './modules/authorization/application/authorization.service.js';
import { registerAuthorizationRoutes } from './modules/authorization/http/authorization.routes.js';
import { createBallotService } from './modules/ballot-box/application/ballot.service.js';
import { registerBallotRoutes } from './modules/ballot-box/http/ballot.routes.js';
import { createCandidateService } from './modules/candidate/application/candidate.service.js';
import { registerCandidateRoutes } from './modules/candidate/http/candidate.routes.js';
import { createElectionService } from './modules/election/application/election.service.js';
import { registerElectionRoutes } from './modules/election/http/election.routes.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { createVoterService } from './modules/voter/application/voter.service.js';
import { registerVoterRoutes } from './modules/voter/http/voter.routes.js';
import { createVoterIdentifierHasher } from './security/voter-identifier.js';
import { systemClock, type Clock } from './shared/clock.js';
import { registerErrorHandling } from './shared/errors/error-handler.js';
import { requireOperator } from './shared/http/operator-auth.js';
import { buildLoggerOptions } from './shared/logging/logger.js';

export interface AppDependencies {
  env: Pick<
    Env,
    | 'LOG_LEVEL'
    | 'NODE_ENV'
    | 'ADMIN_CREDENTIALS'
    | 'POLL_WORKER_CREDENTIALS'
    | 'VOTER_ID_PEPPER'
    | 'VOTING_SESSION_TTL_SECONDS'
  >;
  prisma: PrismaClient;
  /** Injetável para que testes controlem o tempo (abrir/fechar eleições). */
  clock?: Clock;
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

  const { prisma, clock = systemClock } = deps;
  const adminOnly = requireOperator('ADMIN', deps.env.ADMIN_CREDENTIALS);
  const pollWorkerOnly = requireOperator('POLL_WORKER', deps.env.POLL_WORKER_CREDENTIALS);
  const hashVoterIdentifier = createVoterIdentifierHasher(deps.env.VOTER_ID_PEPPER);

  // A API só fala JSON: qualquer outro content-type com body vira 415.
  app.removeContentTypeParser('text/plain');
  registerErrorHandling(app);
  registerHealthRoutes(app, prisma);
  registerElectionRoutes(app, {
    elections: createElectionService({ prisma, clock }),
    requireAdmin: adminOnly,
  });
  registerCandidateRoutes(app, {
    candidates: createCandidateService({ prisma }),
    requireAdmin: adminOnly,
  });
  registerVoterRoutes(app, {
    voters: createVoterService({ prisma, hashVoterIdentifier }),
    requireAdmin: adminOnly,
  });
  registerAuthorizationRoutes(app, {
    authorization: createAuthorizationService({
      prisma,
      clock,
      hashVoterIdentifier,
      sessionTtlSeconds: deps.env.VOTING_SESSION_TTL_SECONDS,
    }),
    requirePollWorker: pollWorkerOnly,
  });
  registerBallotRoutes(app, { ballots: createBallotService({ prisma, clock }) });

  return app;
}
