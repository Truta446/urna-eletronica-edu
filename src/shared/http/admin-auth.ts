import type { FastifyRequest } from 'fastify';
import type { AdminCredential } from '../../security/admin-credentials.js';
import { constantTimeEqual, hashToken, TOKEN_PATTERN } from '../../security/tokens.js';
import { UnauthorizedError } from '../errors/app-error.js';

export interface AdminActor {
  type: 'ADMIN';
  id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminActor?: AdminActor;
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
export function findAdmin(
  credentials: readonly AdminCredential[],
  token: string,
): AdminActor | undefined {
  const presented = hashToken(token);
  let matched: AdminCredential | undefined;
  for (const credential of credentials) {
    if (constantTimeEqual(credential.tokenHash, presented)) matched = credential;
  }
  return matched ? { type: 'ADMIN', id: matched.label } : undefined;
}

/**
 * Hook `onRequest` para rotas /admin: roda ANTES do parse do body, então quem não se autenticou
 * não consegue fazer o servidor processar payload nenhum. Falhas têm resposta idêntica.
 */
export function requireAdmin(credentials: readonly AdminCredential[]) {
  return (request: FastifyRequest): Promise<void> => {
    const token = extractBearerToken(request.headers.authorization);
    const actor = token ? findAdmin(credentials, token) : undefined;
    if (!actor) return Promise.reject(new UnauthorizedError());
    request.adminActor = actor;
    return Promise.resolve();
  };
}

export function getAdminActor(request: FastifyRequest): AdminActor {
  if (!request.adminActor) throw new UnauthorizedError();
  return request.adminActor;
}
