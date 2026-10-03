import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/database.js';
import { addCandidate, createElection } from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { adminHeaders, createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * INV-5: alterar um AuditEvent quebra verifyAuditChain().
 *
 * Simula o atacante mais forte: um superusuário do banco, que DESLIGA os triggers de
 * proteção e edita a tabela diretamente. A prevenção falhou; a detecção não pode falhar.
 */
const clock = createFakeClock();
let electionId = '';
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDatabase(t.prisma);
  const election = await createElection(t, clock.now());
  electionId = election.id;
  for (const number of [1, 2, 3, 4])
    await addCandidate(t, election.id, { number, name: `C${number}` });
  // seq 1 = ELECTION_CREATED; seq 2..5 = CANDIDATE_CREATED
});
afterAll(() => t.close());

async function verify(query = '') {
  const response = await t.app.inject({
    method: 'GET',
    url: `/admin/audit/verify${query}`,
    headers: adminHeaders,
  });
  return response.json<{
    valid: boolean;
    failure?: { seq: number; reason: string; chain?: string };
    head?: { seq: number; hash: string };
  }>();
}

/** Executa SQL como superusuário com o trigger de proteção desligado. */
async function asSuperuser(sql: string) {
  await t.prisma.$transaction([
    t.prisma.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_guard'),
    t.prisma.$executeRawUnsafe(sql),
    t.prisma.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_guard'),
  ]);
}

describe('INV-5: tampering with audit events breaks verifyAuditChain()', () => {
  it('baseline: the untouched chain is valid', async () => {
    expect(await verify()).toMatchObject({ valid: true });
  });

  it('detects a modified payload', async () => {
    await asSuperuser(
      `UPDATE audit_events SET payload = jsonb_set(payload, '{name}', '"Hijacked"') WHERE seq = 3`,
    );
    expect(await verify()).toMatchObject({
      valid: false,
      failure: { seq: 3, reason: 'HASH_MISMATCH' },
    });
  });

  it('detects a changed actor', async () => {
    await asSuperuser(`UPDATE audit_events SET actor_identifier = 'someone-else' WHERE seq = 2`);
    expect(await verify()).toMatchObject({
      valid: false,
      failure: { seq: 2, reason: 'HASH_MISMATCH' },
    });
  });

  it('detects a backdated event', async () => {
    await asSuperuser(
      `UPDATE audit_events SET created_at = created_at - interval '1 day' WHERE seq = 4`,
    );
    expect(await verify()).toMatchObject({
      valid: false,
      failure: { seq: 4, reason: 'HASH_MISMATCH' },
    });
  });

  it('detects a removed event', async () => {
    await asSuperuser('DELETE FROM audit_events WHERE seq = 3');
    expect(await verify()).toMatchObject({
      valid: false,
      failure: { seq: 4, reason: 'SEQUENCE_GAP' },
    });
  });

  it('detects modified order (seq values swapped)', async () => {
    // Troca em três passos: num UPDATE só, a PK (UNIQUE não adiável) rejeitaria a troca.
    await asSuperuser('UPDATE audit_events SET seq = 1000 WHERE seq = 2');
    await asSuperuser('UPDATE audit_events SET seq = 2 WHERE seq = 3');
    await asSuperuser('UPDATE audit_events SET seq = 3 WHERE seq = 1000');
    expect(await verify()).toMatchObject({ valid: false, failure: { seq: 2 } });
  });

  it("detects an election's ENTIRE chain being deleted", async () => {
    await asSuperuser(`DELETE FROM audit_events WHERE chain_key = '${electionId}'`);
    expect(await verify()).toMatchObject({
      valid: false,
      failure: { chain: electionId, reason: 'ELECTION_WITHOUT_AUDIT' },
    });
  });

  it('detects an election chain that does not start with ELECTION_CREATED', async () => {
    await asSuperuser(`DELETE FROM audit_events WHERE chain_key = '${electionId}' AND seq = 1`);
    expect(await verify()).toMatchObject({ valid: false });
  });

  it('LIMITATION: deleting the tail is invisible without an anchor, visible with one', async () => {
    const before = await verify(`?electionId=${electionId}`);
    if (!before.head) throw new Error('empty chain');
    await asSuperuser('DELETE FROM audit_events WHERE seq >= 4');

    expect(await verify()).toMatchObject({ valid: true });
    expect(
      await verify(
        `?electionId=${electionId}&anchorSeq=${before.head.seq}&anchorHash=${before.head.hash}`,
      ),
    ).toMatchObject({
      valid: false,
      failure: { reason: 'ANCHOR_NOT_FOUND' },
    });
  });
});
