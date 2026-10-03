-- =====================================================================
-- Menor privilégio para a aplicação (Fase 9).
--
-- Antes, a aplicação conectava como superusuário: quem roubasse as credenciais
-- dela poderia desligar triggers, apagar votos e reescrever a auditoria.
-- Agora a aplicação usa a role `urna_app`, que só pode o que o código faz.
-- As migrations continuam rodando com a role dona do schema.
--
-- A role é criada sem LOGIN; `npm run db:migrate` (scripts/setup-app-role.ts)
-- define LOGIN e senha a partir de DATABASE_URL. Segredos nunca entram em migrations.
-- Roles são globais no cluster; GRANTs são por banco (esta migration roda em cada um).
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urna_app') THEN
    CREATE ROLE "urna_app" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "urna_app";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO "urna_app";

-- UPDATE por COLUNA: só os campos que mudam por regra de negócio.
-- (SELECT ... FOR SHARE nos triggers exige UPDATE em ao menos uma coluna da tabela.)
GRANT SELECT, INSERT                  ON "elections"           TO "urna_app";
GRANT UPDATE ("status")               ON "elections"           TO "urna_app";
GRANT SELECT, INSERT                  ON "candidates"          TO "urna_app";
GRANT SELECT, INSERT                  ON "voters"              TO "urna_app";
GRANT UPDATE ("has_voted")            ON "voters"              TO "urna_app";
GRANT SELECT, INSERT                  ON "voting_sessions"     TO "urna_app";
GRANT UPDATE ("consumed")             ON "voting_sessions"     TO "urna_app";
GRANT SELECT, INSERT                  ON "ballots"             TO "urna_app";
GRANT SELECT, INSERT, DELETE          ON "idempotency_records" TO "urna_app";
GRANT SELECT, INSERT                  ON "audit_events"        TO "urna_app";
GRANT SELECT, INSERT                  ON "tally_results"       TO "urna_app";
-- Sem acesso a _prisma_migrations. Sem TRUNCATE, sem ALTER, sem DELETE em votos/auditoria.
-- ATENÇÃO: tabelas criadas por migrations futuras precisam de GRANT explícito aqui.
