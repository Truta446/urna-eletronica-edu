import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { electionIdParams } from '../../../shared/validation.js';
import type { VoterService } from '../application/voter.service.js';
import { normalizeCpf } from '../domain/cpf.js';
import { getOperator } from '../../../shared/http/operator-auth.js';

/** A mensagem de erro nunca inclui o valor recebido (é dado pessoal). */
export const voterIdentifier = z
  .string()
  .max(32)
  .transform((value, ctx) => {
    const normalized = normalizeCpf(value);
    if (normalized) return normalized;
    ctx.addIssue({ code: 'custom', message: 'Invalid CPF' });
    return z.NEVER;
  });

const registerVoterBody = z.strictObject({ voterIdentifier });

export function registerVoterRoutes(
  app: FastifyInstance,
  deps: { voters: VoterService; requireAdmin: onRequestAsyncHookHandler },
): void {
  const { voters, requireAdmin } = deps;

  app.post('/admin/elections/:id/voters', { onRequest: requireAdmin }, async (request, reply) => {
    const { id } = electionIdParams.parse(request.params);
    const body = registerVoterBody.parse(request.body);
    return reply
      .status(201)
      .send(await voters.register(id, body.voterIdentifier, getOperator(request)));
  });
}
