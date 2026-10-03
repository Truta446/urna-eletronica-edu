import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/database.js';
import {
  authorizeVoter,
  castBallot,
  createElectionWithTokens,
  createVotingElection,
} from '../helpers/factories.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * RISCOS CONHECIDOS — estes testes NÃO provam que o sistema é seguro; provam que um vazamento
 * existe, para que ele fique visível e documentado (docs/threat-model.md, T07).
 * Se algum dia uma mitigação for implementada, o teste correspondente deve ser invertido.
 */
const clock = createFakeClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(() => resetDatabase(t.prisma));
afterAll(() => t.close());

describe('KNOWN RISK: PostgreSQL system columns link voter and session', () => {
  it('voters.xmin equals voting_sessions.xmin, because both rows are written by the same transaction', async () => {
    const { election, cpfs } = await createVotingElection(t, clock, { voters: 5 });
    for (const cpf of cpfs)
      expect((await authorizeVoter(t, election.id, cpf)).statusCode).toBe(201);

    // Um DBA (ou quem tem um backup físico) consegue fazer este JOIN, sem nenhuma FK:
    const linked = await t.prisma.$queryRaw<{ voter_id: string; session_id: string }[]>`
      SELECT v.id AS voter_id, s.id AS session_id
        FROM voters v
        JOIN voting_sessions s ON s.xmin = v.xmin
       WHERE v.has_voted`;

    expect(linked).toHaveLength(5);
    expect(new Set(linked.map((row) => row.voter_id)).size).toBe(5);
  });
});

describe('KNOWN RISK: PostgreSQL system columns link session and ballot', () => {
  it('voting_sessions.xmin equals ballots.xmin, because consuming and storing happen in one transaction', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 5 });
    for (const token of tokens) {
      expect((await castBallot(t, { token, electionId: election.id })).statusCode).toBe(201);
    }

    const linked = await t.prisma.$queryRaw<{ session_id: string; ballot_id: string }[]>`
      SELECT s.id AS session_id, b.id AS ballot_id
        FROM voting_sessions s
        JOIN ballots b ON b.xmin = s.xmin`;
    expect(linked).toHaveLength(5);
  });

  it('after voting, the LIVE voter row no longer shares xmin with the session (the UPDATE rewrote it)', async () => {
    const { election, tokens } = await createElectionWithTokens(t, clock, { voters: 5 });
    for (const token of tokens) await castBallot(t, { token, electionId: election.id });

    // O vínculo eleitor <-> sessão some das linhas vivas, mas a versão antiga da linha (dead
    // tuple) continua no disco até o VACUUM: quem lê páginas cruas ainda o encontra.
    const linked = await t.prisma.$queryRaw<unknown[]>`
      SELECT 1 FROM voters v JOIN voting_sessions s ON s.xmin = v.xmin WHERE v.has_voted`;
    expect(linked).toHaveLength(0);
  });
});
