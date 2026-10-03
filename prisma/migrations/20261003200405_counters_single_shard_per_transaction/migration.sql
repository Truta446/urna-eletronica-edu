-- Correção de DEADLOCK nos contadores fragmentados (encontrado pela suíte, intermitente,
-- e confirmado nos logs do PostgreSQL: "deadlock detected ... relation ballot_counters").
--
-- Com o shard escolhido por random() a CADA incremento, um voto travava o shard X
-- (consumida) e depois o Y (voto); outro voto, Y e depois X: ordem de lock invertida.
-- Agora o shard é derivado do id da transação: os dois incrementos de uma transação
-- caem na MESMA linha, e nenhuma transação segura dois shards. Sem ciclo, sem deadlock.
CREATE OR REPLACE FUNCTION "counters_increment"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  target SMALLINT := (pg_current_xact_id()::text::bigint % 16)::smallint;
BEGIN
  IF TG_TABLE_NAME = 'voters' THEN
    UPDATE "authorization_counters" SET "authorized_voters" = "authorized_voters" + 1
     WHERE "election_id" = NEW."election_id" AND "shard" = target;
  ELSIF TG_TABLE_NAME = 'voting_sessions' AND TG_OP = 'INSERT' THEN
    UPDATE "authorization_counters" SET "sessions" = "sessions" + 1
     WHERE "election_id" = NEW."election_id" AND "shard" = target;
  ELSIF TG_TABLE_NAME = 'voting_sessions' THEN
    UPDATE "ballot_counters" SET "consumed_sessions" = "consumed_sessions" + 1
     WHERE "election_id" = NEW."election_id" AND "shard" = target;
  ELSE
    UPDATE "ballot_counters" SET "ballots" = "ballots" + 1
     WHERE "election_id" = NEW."election_id" AND "shard" = target;
  END IF;
  RETURN NULL;
END;
$$;
