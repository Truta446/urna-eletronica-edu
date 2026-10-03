-- =====================================================================
-- Performance (benchmark, 2ª rodada): contadores FRAGMENTADOS.
--
-- Com uma linha de contador por eleição, todo voto incrementava a MESMA
-- linha e segurava o lock dela até o COMMIT: os votos de uma eleição viravam
-- uma fila (~250 votos/s, p95 ~100 ms no benchmark).
-- Agora cada eleição tem 16 linhas ("shards"); cada incremento escolhe uma
-- ao acaso e os balanços SOMAM as 16. Continua O(1); a disputa cai ~16x.
--
-- Correção da soma sob concorrência: cada transação soma +1 em "consumidas"
-- e +1 em "votos" (ou +1 em habilitados e +1 em sessões), possivelmente em
-- shards diferentes. Em READ COMMITTED, a soma vê o que já foi confirmado
-- (sempre balanceado) mais os incrementos da própria transação.
-- =====================================================================

ALTER TABLE "authorization_counters" ADD COLUMN "shard" SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "authorization_counters" DROP CONSTRAINT "authorization_counters_pkey";
ALTER TABLE "authorization_counters" ADD PRIMARY KEY ("election_id", "shard");
ALTER TABLE "authorization_counters" ADD CONSTRAINT "authorization_counters_shard_check" CHECK ("shard" BETWEEN 0 AND 15);

ALTER TABLE "ballot_counters" ADD COLUMN "shard" SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "ballot_counters" DROP CONSTRAINT "ballot_counters_pkey";
ALTER TABLE "ballot_counters" ADD PRIMARY KEY ("election_id", "shard");
ALTER TABLE "ballot_counters" ADD CONSTRAINT "ballot_counters_shard_check" CHECK ("shard" BETWEEN 0 AND 15);

-- As linhas existentes viram o shard 0; criam-se os shards 1..15 zerados.
INSERT INTO "authorization_counters" ("election_id", "shard")
SELECT e."id", s FROM "elections" e CROSS JOIN generate_series(1, 15) AS s;
INSERT INTO "ballot_counters" ("election_id", "shard")
SELECT e."id", s FROM "elections" e CROSS JOIN generate_series(1, 15) AS s;

CREATE OR REPLACE FUNCTION "election_counters_init"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO "authorization_counters" ("election_id", "shard")
  SELECT NEW."id", s FROM generate_series(0, 15) AS s;
  INSERT INTO "ballot_counters" ("election_id", "shard")
  SELECT NEW."id", s FROM generate_series(0, 15) AS s;
  RETURN NULL;
END;
$$;

-- random() aqui só distribui carga; não tem papel de segurança.
CREATE OR REPLACE FUNCTION "counters_increment"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  target SMALLINT := floor(random() * 16)::smallint;
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

CREATE OR REPLACE FUNCTION "authorization_balance_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total_sessions BIGINT;
  total_authorized BIGINT;
BEGIN
  SELECT sum("sessions"), sum("authorized_voters") INTO total_sessions, total_authorized
    FROM "authorization_counters" WHERE "election_id" = NEW."election_id";
  IF total_sessions IS DISTINCT FROM total_authorized THEN
    RAISE EXCEPTION 'authorization_unbalanced: % sessions for % authorized voters',
      total_sessions, total_authorized
      USING ERRCODE = 'UE007';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "ballot_balance_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total_ballots BIGINT;
  total_consumed BIGINT;
BEGIN
  SELECT sum("ballots"), sum("consumed_sessions") INTO total_ballots, total_consumed
    FROM "ballot_counters" WHERE "election_id" = NEW."election_id";
  IF total_ballots IS DISTINCT FROM total_consumed THEN
    RAISE EXCEPTION 'ballot_unbalanced: % ballots for % consumed sessions',
      total_ballots, total_consumed
      USING ERRCODE = 'UE009';
  END IF;
  RETURN NULL;
END;
$$;
