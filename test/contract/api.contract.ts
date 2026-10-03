import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import {
  ADMIN_TOKEN,
  POLL_TOKEN,
  authorize,
  client,
  closeWhenAllowed,
  cpf,
  vote,
  votingElection,
} from './client.js';

const future = (ms: number) => new Date(Date.now() + ms).toISOString();

describe.each(inject('servers'))('contrato HTTP: $name', ({ url }) => {
  const c = client(url);

  describe('borda HTTP', () => {
    it('health e rota inexistente', async () => {
      expect((await c.call('GET', '/health')).body).toEqual({ status: 'ok' });
      const ready = await c.call('GET', '/health/ready');
      expect(ready.status).toBe(200);
      const missing = await c.call('GET', '/nao-existe');
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
    });

    it('headers de segurança em toda resposta', async () => {
      const { headers } = await c.call('GET', '/health');
      expect(headers.get('x-content-type-options')).toBe('nosniff');
      expect(headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(headers.get('referrer-policy')).toBe('no-referrer');
      expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(headers.get('cache-control')).toBe('no-store');
    });

    it('autentica ANTES de ler o corpo (401 mesmo com JSON quebrado)', async () => {
      const res = await c.call('POST', '/admin/elections', { raw: '{quebrado' });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    });

    it('token de mesário não vale como admin, e vice-versa', async () => {
      expect((await c.call('GET', '/admin/audit', { token: POLL_TOKEN })).status).toBe(401);
      const res = await c.call('POST', `/elections/${randomUUID()}/voting-sessions`, {
        token: ADMIN_TOKEN,
        body: { voterIdentifier: cpf() },
      });
      expect(res.status).toBe(401);
    });

    it('JSON inválido → 400; tipo errado → 415; corpo grande → 413', async () => {
      const bad = await c.call('POST', '/admin/elections', {
        token: ADMIN_TOKEN,
        raw: '{quebrado',
      });
      expect(bad.status).toBe(400);
      const text = await c.call('POST', '/admin/elections', {
        token: ADMIN_TOKEN,
        raw: 'oi',
        headers: { 'content-type': 'text/plain' },
      });
      expect(text.status).toBe(415);
      const big = await c.call('POST', '/admin/elections', {
        token: ADMIN_TOKEN,
        body: { name: 'x'.repeat(20_000), startsAt: future(60_000), endsAt: future(120_000) },
      });
      expect(big.status).toBe(413);
    });

    it('campos desconhecidos e id fora do formato UUID → 400', async () => {
      const extra = await c.call('POST', '/admin/elections', {
        token: ADMIN_TOKEN,
        body: { name: 'X', startsAt: future(60_000), endsAt: future(120_000), admin: true },
      });
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect((await c.call('GET', '/elections/123')).status).toBe(400);
      expect((await c.call('GET', `/elections/${randomUUID()}`)).status).toBe(404);
    });

    it('CPF inválido é recusado sem ecoar o valor', async () => {
      const created = await c.call<{ id: string }>('POST', '/admin/elections', {
        token: ADMIN_TOKEN,
        body: { name: 'CPF', startsAt: future(60_000), endsAt: future(120_000) },
      });
      const res = await c.call('POST', `/admin/elections/${created.body.id}/voters`, {
        token: ADMIN_TOKEN,
        body: { voterIdentifier: '123.456.789-00' },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('123.456.789');
    });
  });

  describe('regras de negócio', () => {
    it('agenda: fim antes do início, início no passado, mais de 30 dias → 422', async () => {
      const post = (startsAt: string, endsAt: string) =>
        c.call('POST', '/admin/elections', {
          token: ADMIN_TOKEN,
          body: { name: 'Agenda', startsAt, endsAt },
        });
      expect((await post(future(120_000), future(60_000))).status).toBe(422);
      expect((await post(future(-60_000), future(60_000))).status).toBe(422);
      expect((await post(future(60_000), future(31 * 86_400_000))).status).toBe(422);
    });

    it('abrir exige candidato e eleitor; candidato duplicado → 409', async () => {
      const { body } = await c.call<{ id: string }>('POST', '/admin/elections', {
        token: ADMIN_TOKEN,
        body: { name: 'Vazia', startsAt: future(60_000), endsAt: future(120_000) },
      });
      expect(
        (await c.call('POST', `/admin/elections/${body.id}/open`, { token: ADMIN_TOKEN })).status,
      ).toBe(422);
      const add = () =>
        c.call('POST', `/admin/elections/${body.id}/candidates`, {
          token: ADMIN_TOKEN,
          body: { number: 7, name: 'A' },
        });
      expect((await add()).status).toBe(201);
      expect((await add()).status).toBe(409);
    });

    it('fechar antes do fim → 422; eleição aberta não aceita novos eleitores → 409', async () => {
      const { id } = await votingElection(c, { durationMs: 60_000 });
      expect(
        (await c.call('POST', `/admin/elections/${id}/close`, { token: ADMIN_TOKEN })).status,
      ).toBe(422);
      const late = await c.call('POST', `/admin/elections/${id}/voters`, {
        token: ADMIN_TOKEN,
        body: { voterIdentifier: cpf() },
      });
      expect(late.status).toBe(409);
    });
  });

  describe('habilitação e voto', () => {
    it('fluxo completo: um voto por eleitor, idempotência e reuso do token', async () => {
      const { id, cpfs } = await votingElection(c, { durationMs: 60_000 });
      const voter = cpfs[0] ?? '';
      const token = await authorize(c, id, voter);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // segunda habilitação do mesmo eleitor
      const again = await c.call('POST', `/elections/${id}/voting-sessions`, {
        token: POLL_TOKEN,
        body: { voterIdentifier: voter },
      });
      expect(again.status).toBe(409);
      // eleitor não cadastrado
      const stranger = await c.call('POST', `/elections/${id}/voting-sessions`, {
        token: POLL_TOKEN,
        body: { voterIdentifier: cpf() },
      });
      expect(stranger.status).toBe(404);

      const key = randomUUID();
      const first = await vote(c, id, token, { type: 'candidate', number: 13 }, key);
      expect(first.status).toBe(201);
      expect(first.body).toEqual({ accepted: true });
      expect(first.headers.get('idempotent-replayed')).toBe('false');

      const retry = await vote(c, id, token, { type: 'candidate', number: 13 }, key);
      expect(retry.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');

      const changed = await vote(c, id, token, { type: 'blank' }, key);
      expect(changed.status).toBe(422);

      const reuse = await vote(c, id, token, { type: 'blank' });
      expect(reuse.status).toBe(409);
    });

    it('token inválido → 401; Idempotency-Key ausente → 400; candidato inexistente → 422 sem gastar o token', async () => {
      const { id, cpfs } = await votingElection(c, { durationMs: 60_000 });
      expect((await vote(c, id, 'A'.repeat(43), { type: 'blank' })).status).toBe(401);

      const token = await authorize(c, id, cpfs[0] ?? '');
      const noKey = await c.call('POST', '/ballots', {
        token,
        body: { electionId: id, choice: { type: 'blank' } },
      });
      expect(noKey.status).toBe(400);

      expect((await vote(c, id, token, { type: 'candidate', number: 99 })).status).toBe(422);
      expect((await vote(c, id, token, { type: 'candidate', number: 13, extra: 1 })).status).toBe(
        400,
      );
      expect((await vote(c, randomUUID(), token, { type: 'blank' })).status).toBe(422);
      // o token continua válido depois dos erros
      expect((await vote(c, id, token, { type: 'null' })).status).toBe(201);
    });

    it('corrida: 20 envios simultâneos com o mesmo token geram exatamente 1 voto', async () => {
      const { id, cpfs } = await votingElection(c, { durationMs: 60_000 });
      const token = await authorize(c, id, cpfs[0] ?? '');
      const results = await Promise.all(
        Array.from({ length: 20 }, () => vote(c, id, token, { type: 'blank' })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
    });

    it('corrida: 20 habilitações simultâneas do mesmo eleitor geram exatamente 1 token', async () => {
      const { id, cpfs } = await votingElection(c, { durationMs: 60_000 });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          c.call('POST', `/elections/${id}/voting-sessions`, {
            token: POLL_TOKEN,
            body: { voterIdentifier: cpfs[0] },
          }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    });

    it('expiração do token arredondada para cima ao minuto e limitada ao fim da eleição', async () => {
      const { id, cpfs, endsAt } = await votingElection(c, { durationMs: 8000 });
      const res = await c.call<{ expiresAt: string }>('POST', `/elections/${id}/voting-sessions`, {
        token: POLL_TOKEN,
        body: { voterIdentifier: cpfs[0] },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(new Date(res.body.expiresAt).getTime()).toBe(endsAt.getTime());
    });
  });

  describe('encerramento, apuração e publicação', () => {
    it('apuração assinada, auditoria íntegra, nada publicado antes', async () => {
      const { id, cpfs, endsAt } = await votingElection(c, { voters: 4, durationMs: 5000 });
      const choices = [
        { type: 'candidate', number: 13 },
        { type: 'candidate', number: 13 },
        { type: 'blank' },
      ];
      for (const [i, choice] of choices.entries()) {
        expect((await vote(c, id, await authorize(c, id, cpfs[i] ?? ''), choice)).status).toBe(201);
      }
      expect((await c.call('GET', `/elections/${id}/tally`)).status).toBe(409);
      await closeWhenAllowed(c, id, endsAt);
      expect((await c.call('GET', `/elections/${id}/ballots`)).status).toBe(409);

      const tally = await c.call<{
        result: {
          candidates: { number: number; votes: number }[];
          blank: number;
          null: number;
          totalBallots: number;
        };
        turnout: Record<string, number>;
        seal: { ballots: number };
        signature: string;
      }>('POST', `/admin/elections/${id}/tally`, { token: ADMIN_TOKEN });
      expect(tally.status).toBe(201);
      expect(tally.body.result).toMatchObject({ blank: 1, null: 0, totalBallots: 3 });
      expect(tally.body.result.candidates.map((x) => [x.number, x.votes])).toEqual([
        [13, 2],
        [45, 0],
      ]);
      expect(tally.body.turnout).toEqual({
        registeredVoters: 4,
        authorizedVoters: 3,
        authorizedWithoutBallot: 0,
      });
      expect(tally.body.seal.ballots).toBe(3);

      expect(
        (await c.call('POST', `/admin/elections/${id}/tally`, { token: ADMIN_TOKEN })).status,
      ).toBe(409);
      const published = await c.call('GET', `/elections/${id}/tally`);
      expect(published.body).toEqual(tally.body);

      const ballots = await c.call<{ ballots: Record<string, unknown>[] }>(
        'GET',
        `/elections/${id}/ballots`,
      );
      expect(ballots.body.ballots).toHaveLength(3);
      for (const b of ballots.body.ballots) {
        expect(Object.keys(b).sort()).toEqual(['candidateId', 'commitment', 'id', 'kind']);
      }

      const verify = await c.call<{ valid: boolean; chain: string }>(
        'GET',
        `/admin/audit/verify?electionId=${id}`,
        { token: ADMIN_TOKEN },
      );
      expect(verify.body).toMatchObject({ valid: true, chain: id });
    });

    it('auditoria: eventos de habilitação não identificam o eleitor', async () => {
      const { id, cpfs } = await votingElection(c, { durationMs: 60_000 });
      await authorize(c, id, cpfs[0] ?? '');
      const audit = await c.call<{
        events: { eventType: string; payload: Record<string, unknown> }[];
      }>('GET', `/admin/audit?electionId=${id}&limit=500`, { token: ADMIN_TOKEN });
      const authorized = audit.body.events.filter((e) => e.eventType === 'VOTER_AUTHORIZED');
      expect(authorized).toHaveLength(1);
      expect(Object.keys(authorized[0]?.payload ?? {}).sort()).toEqual([
        'keyId',
        'nonce',
        'signature',
      ]);
      expect(JSON.stringify(audit.body)).not.toContain(cpfs[0]);

      const unknownParam = await c.call('GET', '/admin/audit?foo=1', { token: ADMIN_TOKEN });
      expect(unknownParam.status).toBe(400);
    });
  });
});
