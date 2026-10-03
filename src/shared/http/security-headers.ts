import type { FastifyInstance } from 'fastify';

/**
 * Headers defensivos para uma API JSON (sem HTML, sem browser como cliente principal):
 * - nosniff: o browser não reinterpreta JSON como outro tipo;
 * - CSP/frame-ancestors 'none': nada desta API pode ser executado ou embutido;
 * - no-referrer e CORP same-origin: nada vaza para outros sites;
 * - Cache-Control no-store por padrão: respostas com tokens/resultados não ficam em caches.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    done(null, payload);
  });
}
