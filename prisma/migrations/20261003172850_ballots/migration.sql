-- CreateEnum
CREATE TYPE "ballot_kind" AS ENUM ('CANDIDATE', 'BLANK', 'NULL_VOTE');

-- CreateTable
CREATE TABLE "ballots" (
    "id" UUID NOT NULL,
    "election_id" UUID NOT NULL,
    "kind" "ballot_kind" NOT NULL,
    "candidate_id" UUID,
    "nullifier" BYTEA NOT NULL,
    "commitment" BYTEA NOT NULL,

    CONSTRAINT "ballots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "scope_key" BYTEA NOT NULL,
    "election_id" UUID NOT NULL,
    "request_fingerprint" BYTEA NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("scope_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "ballots_nullifier_key" ON "ballots"("nullifier");

-- CreateIndex
CREATE UNIQUE INDEX "ballots_commitment_key" ON "ballots"("commitment");

-- CreateIndex
CREATE INDEX "ballots_election_id_idx" ON "ballots"("election_id");

-- CreateIndex
CREATE INDEX "idempotency_records_election_id_idx" ON "idempotency_records"("election_id");

-- AddForeignKey
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_election_id_candidate_id_fkey" FOREIGN KEY ("election_id", "candidate_id") REFERENCES "candidates"("election_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =====================================================================
-- Invariantes da urna. Ver docs/threat-model.md (T03, T04, T05, T07).
-- =====================================================================

ALTER TABLE "ballots"
  -- Voto em candidato <=> candidate_id preenchido. Branco/nulo nunca apontam para candidato.
  ADD CONSTRAINT "ballots_kind_candidate_check"
    CHECK (("kind" = 'CANDIDATE') = ("candidate_id" IS NOT NULL)),
  ADD CONSTRAINT "ballots_nullifier_length_check" CHECK (octet_length("nullifier") = 32),
  ADD CONSTRAINT "ballots_commitment_length_check" CHECK (octet_length("commitment") = 32);

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_scope_key_length_check" CHECK (octet_length("scope_key") = 32),
  ADD CONSTRAINT "idempotency_records_fingerprint_length_check"
    CHECK (octet_length("request_fingerprint") = 32),
  ADD CONSTRAINT "idempotency_records_status_check" CHECK ("response_status" BETWEEN 200 AND 599);

-- Urna append-only ------------------------------------------------------
--  * votos só entram com a eleição OPEN (UE005);
--  * votos nunca são alterados nem apagados (UE008).
CREATE FUNCTION "ballots_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "election_status";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ballot_immutable: ballots cannot be updated or deleted' USING ERRCODE = 'UE008';
  END IF;

  SELECT "status" INTO current_status FROM "elections" WHERE "id" = NEW."election_id" FOR SHARE;
  IF current_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'election_not_open: ballots can only be cast while the election is OPEN'
      USING ERRCODE = 'UE005';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ballots_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ballots"
  FOR EACH ROW EXECUTE FUNCTION "ballots_guard"();

-- Balanço da urna ------------------------------------------------------
-- Invariante: por eleição, nº de votos == nº de sessões consumidas.
-- Com o balanço de habilitações (Fase 4): votos == tokens usados <= eleitores habilitados.
-- Inserir voto sem consumir token, ou consumir token sem gravar voto, falha no COMMIT (UE009).
-- As duas contagens ficam num ÚNICO comando (um snapshot), lição da Fase 4.
CREATE INDEX "voting_sessions_election_id_consumed_idx"
  ON "voting_sessions"("election_id") WHERE "consumed";

CREATE FUNCTION "ballot_balance_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ballots_count bigint;
  consumed_count bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM "ballots" WHERE "election_id" = NEW."election_id"),
    (SELECT count(*) FROM "voting_sessions" WHERE "election_id" = NEW."election_id" AND "consumed")
  INTO ballots_count, consumed_count;

  IF ballots_count <> consumed_count THEN
    RAISE EXCEPTION 'ballot_unbalanced: % ballots for % consumed sessions',
      ballots_count, consumed_count
      USING ERRCODE = 'UE009';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ballots_balance"
  AFTER INSERT ON "ballots"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ballot_balance_check"();

CREATE CONSTRAINT TRIGGER "voting_sessions_consumed_balance"
  AFTER UPDATE OF "consumed" ON "voting_sessions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."consumed" AND NOT OLD."consumed")
  EXECUTE FUNCTION "ballot_balance_check"();
