-- =====================================================================
-- Performance (benchmark): balanços em O(1) com contadores.
--
-- Antes: a cada habilitação e a cada voto, os triggers de balanço faziam
-- count(*) sobre a eleição inteira (4 contagens por operação). Com 50 mil
-- votos, a latência da habilitação ia de 53 ms para 136 ms e a vazão caía
-- pela metade: custo O(n) por operação, O(n²) na eleição.
--
-- Agora: contadores mantidos por triggers SECURITY DEFINER. A role da
-- aplicação só pode LER os contadores; nunca os altera diretamente.
-- Duas tabelas separadas para que votos não esperem atrás de habilitações
-- (cada operação trava a linha do seu contador até o COMMIT).
-- A garantia não muda: "sessões == habilitados" e "votos == consumidas".
-- =====================================================================

CREATE TABLE "authorization_counters" (
  "election_id"       UUID   PRIMARY KEY REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "authorized_voters" BIGINT NOT NULL DEFAULT 0 CHECK ("authorized_voters" >= 0),
  "sessions"          BIGINT NOT NULL DEFAULT 0 CHECK ("sessions" >= 0)
);

CREATE TABLE "ballot_counters" (
  "election_id"       UUID   PRIMARY KEY REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "consumed_sessions" BIGINT NOT NULL DEFAULT 0 CHECK ("consumed_sessions" >= 0),
  "ballots"           BIGINT NOT NULL DEFAULT 0 CHECK ("ballots" >= 0)
);

-- Eleições já existentes: contadores a partir do estado atual.
INSERT INTO "authorization_counters" ("election_id", "authorized_voters", "sessions")
SELECT e."id",
       (SELECT count(*) FROM "voters" v WHERE v."election_id" = e."id" AND v."has_voted"),
       (SELECT count(*) FROM "voting_sessions" s WHERE s."election_id" = e."id")
  FROM "elections" e;

INSERT INTO "ballot_counters" ("election_id", "consumed_sessions", "ballots")
SELECT e."id",
       (SELECT count(*) FROM "voting_sessions" s WHERE s."election_id" = e."id" AND s."consumed"),
       (SELECT count(*) FROM "ballots" b WHERE b."election_id" = e."id")
  FROM "elections" e;

-- Toda eleição nova nasce com os dois contadores zerados.
CREATE FUNCTION "election_counters_init"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO "authorization_counters" ("election_id") VALUES (NEW."id");
  INSERT INTO "ballot_counters" ("election_id") VALUES (NEW."id");
  RETURN NULL;
END;
$$;

CREATE TRIGGER "election_counters_init"
  AFTER INSERT ON "elections"
  FOR EACH ROW EXECUTE FUNCTION "election_counters_init"();

-- Incrementos. SECURITY DEFINER: rodam com os privilégios do dono, então a role
-- da aplicação não precisa (e não tem) UPDATE nos contadores.
CREATE FUNCTION "counters_increment"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'voters' THEN
    UPDATE "authorization_counters" SET "authorized_voters" = "authorized_voters" + 1
     WHERE "election_id" = NEW."election_id";
  ELSIF TG_TABLE_NAME = 'voting_sessions' AND TG_OP = 'INSERT' THEN
    UPDATE "authorization_counters" SET "sessions" = "sessions" + 1
     WHERE "election_id" = NEW."election_id";
  ELSIF TG_TABLE_NAME = 'voting_sessions' THEN
    UPDATE "ballot_counters" SET "consumed_sessions" = "consumed_sessions" + 1
     WHERE "election_id" = NEW."election_id";
  ELSE
    UPDATE "ballot_counters" SET "ballots" = "ballots" + 1
     WHERE "election_id" = NEW."election_id";
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "voters_count_authorized"
  AFTER UPDATE OF "has_voted" ON "voters"
  FOR EACH ROW WHEN (NEW."has_voted" AND NOT OLD."has_voted")
  EXECUTE FUNCTION "counters_increment"();

CREATE TRIGGER "voting_sessions_count_inserted"
  AFTER INSERT ON "voting_sessions"
  FOR EACH ROW EXECUTE FUNCTION "counters_increment"();

CREATE TRIGGER "voting_sessions_count_consumed"
  AFTER UPDATE OF "consumed" ON "voting_sessions"
  FOR EACH ROW WHEN (NEW."consumed" AND NOT OLD."consumed")
  EXECUTE FUNCTION "counters_increment"();

CREATE TRIGGER "ballots_count_inserted"
  AFTER INSERT ON "ballots"
  FOR EACH ROW EXECUTE FUNCTION "counters_increment"();

-- Balanços (mesmos nomes, mesmos códigos UE007/UE009), agora em O(1).
CREATE OR REPLACE FUNCTION "authorization_balance_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  counters "authorization_counters";
BEGIN
  SELECT * INTO counters FROM "authorization_counters" WHERE "election_id" = NEW."election_id";
  IF counters."sessions" IS DISTINCT FROM counters."authorized_voters" THEN
    RAISE EXCEPTION 'authorization_unbalanced: % sessions for % authorized voters',
      counters."sessions", counters."authorized_voters"
      USING ERRCODE = 'UE007';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "ballot_balance_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  counters "ballot_counters";
BEGIN
  SELECT * INTO counters FROM "ballot_counters" WHERE "election_id" = NEW."election_id";
  IF counters."ballots" IS DISTINCT FROM counters."consumed_sessions" THEN
    RAISE EXCEPTION 'ballot_unbalanced: % ballots for % consumed sessions',
      counters."ballots", counters."consumed_sessions"
      USING ERRCODE = 'UE009';
  END IF;
  RETURN NULL;
END;
$$;

-- A aplicação só lê os contadores.
GRANT SELECT ON "authorization_counters" TO "urna_app";
GRANT SELECT ON "ballot_counters" TO "urna_app";
