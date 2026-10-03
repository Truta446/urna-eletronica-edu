-- Correção de um falso positivo em authorization_balance_check (UE007).
--
-- A versão anterior fazia dois SELECT count(*) em comandos separados. Em READ COMMITTED,
-- cada comando enxerga um snapshot próprio: se outra habilitação fizesse COMMIT entre os
-- dois, a função via N sessões e N+1 eleitores e rejeitava uma transação correta.
-- Encontrado pelo teste "keeps sessions == authorized voters under concurrent authorizations".
--
-- Agora as duas contagens estão em UM comando, logo em UM snapshot.
-- (A migration original não foi editada: migrations aplicadas são imutáveis.)
CREATE OR REPLACE FUNCTION "authorization_balance_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sessions_count bigint;
  authorized_count bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM "voting_sessions" WHERE "election_id" = NEW."election_id"),
    (SELECT count(*) FROM "voters" WHERE "election_id" = NEW."election_id" AND "has_voted")
  INTO sessions_count, authorized_count;

  IF sessions_count <> authorized_count THEN
    RAISE EXCEPTION 'authorization_unbalanced: % sessions for % authorized voters',
      sessions_count, authorized_count
      USING ERRCODE = 'UE007';
  END IF;
  RETURN NULL;
END;
$$;
