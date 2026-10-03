import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { describeDatabaseError, mapDatabaseError } from '../../database/errors.js';
import { AppError, type ErrorCode } from './app-error.js';

interface ErrorBody {
  error: {
    code: ErrorCode | 'ROUTE_NOT_FOUND';
    message: string;
    issues?: { path: string; message: string }[];
  };
}

function send(reply: FastifyReply, statusCode: number, body: ErrorBody): FastifyReply {
  return reply.status(statusCode).send(body);
}

function isClientFastifyError(error: FastifyError): boolean {
  return typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500;
}

/**
 * Tratamento centralizado de erros. Regras:
 * - erros conhecidos viram respostas com código estável;
 * - erros de validação listam caminho + mensagem, nunca o valor recebido;
 * - erros inesperados viram 500 genérico; detalhes só no log do servidor.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return send(reply, error.statusCode, { error: { code: error.code, message: error.message } });
    }

    const mapped = mapDatabaseError(error);
    if (mapped) {
      return send(reply, mapped.statusCode, {
        error: { code: mapped.code, message: mapped.message },
      });
    }

    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return send(reply, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', issues },
      });
    }

    // Erros do próprio Fastify: JSON malformado, body grande demais, content-type inválido...
    if (isClientFastifyError(error)) {
      return send(reply, error.statusCode ?? 400, {
        error: { code: 'BAD_REQUEST', message: error.message },
      });
    }

    const databaseError = describeDatabaseError(error);
    request.log.error(databaseError ? { databaseError } : { err: error }, 'unhandled error');
    return send(reply, 500, {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    send(reply, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' } }),
  );
}
