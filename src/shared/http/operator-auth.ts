import type { FastifyRequest } from 'fastify';
import type { OperatorCredential } from '../../security/operator-credentials.js';
import { constantTimeEqual, hashToken, TOKEN_PATTERN } from '../../security/tokens.js';
import { UnauthorizedError } from '../errors/app-error.js';

/**
 * Papéis separados de propósito (separação de funções):
 * - ADMIN configura eleições, mas NÃO habilita eleitores;
 * - POLL_WORKER habilita eleitores, mas NÃO acessa /admin.
 */
export type OperatorRole = 'ADMIN' | 'POLL_WORKER';

export interface Operator {
  role: OperatorRole;
  id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    operator?: Operator;
  }
}

export function extractBearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? '');
  const token = match?.[1];
  return token && TOKEN_PATTERN.test(token) ? token : undefined;
}

/**
 * Compara contra TODAS as credenciais, sem sair no primeiro acerto, para que o tempo de
 * resposta não indique qual credencial (ou posição) bateu.
 */
export function findOperator(
  credentials: readonly OperatorCredential[],
  role: OperatorRole,
  token: string,
): Operator | undefined {
  const presented = hashToken(token);
  let matched: OperatorCredential | undefined;
  for (const credential of credentials) {
    if (constantTimeEqual(credential.tokenHash, presented)) matched = credential;
  }
  return matched ? { role, id: matched.label } : undefined;
}

/**
 * Hook `onRequest`: roda ANTES do parse do body, então quem não se autenticou não consegue
 * fazer o servidor processar payload nenhum. Falhas têm resposta idêntica, qualquer que seja o motivo.
 */
export function requireOperator(role: OperatorRole, credentials: readonly OperatorCredential[]) {
  return (request: FastifyRequest): Promise<void> => {
    const token = extractBearerToken(request.headers.authorization);
    const operator = token ? findOperator(credentials, role, token) : undefined;
    if (!operator) return Promise.reject(new UnauthorizedError());
    request.operator = operator;
    return Promise.resolve();
  };
}
