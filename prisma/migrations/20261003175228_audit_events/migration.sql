-- CreateEnum
CREATE TYPE "audit_event_type" AS ENUM ('ELECTION_CREATED', 'CANDIDATE_CREATED', 'VOTER_REGISTERED', 'ELECTION_OPENED', 'VOTER_AUTHORIZED', 'ELECTION_CLOSED', 'BALLOT_BOX_SEALED', 'TALLY_STARTED', 'TALLY_COMPLETED');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('ADMIN', 'POLL_WORKER', 'SYSTEM');

-- CreateTable
CREATE TABLE "audit_events" (
    "seq" INTEGER NOT NULL,
    "event_type" "audit_event_type" NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_identifier" TEXT NOT NULL,
    "election_id" UUID,
    "payload" JSONB NOT NULL,
    "previous_hash" BYTEA NOT NULL,
    "event_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_event_hash_key" ON "audit_events"("event_hash");

-- CreateIndex
CREATE INDEX "audit_events_election_id_seq_idx" ON "audit_events"("election_id", "seq");

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =====================================================================
-- Audit log append-only em hash chain. Ver docs/security.md e T11.
-- O banco garante o ENCADEAMENTO (seq contíguo, previous_hash correto);
-- o hash de cada evento (JSON canônico RFC 8785) é verificado por
-- verifyAuditChain() na aplicação.
-- =====================================================================

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_seq_check" CHECK ("seq" >= 1),
  ADD CONSTRAINT "audit_events_previous_hash_length_check" CHECK (octet_length("previous_hash") = 32),
  ADD CONSTRAINT "audit_events_event_hash_length_check" CHECK (octet_length("event_hash") = 32),
  ADD CONSTRAINT "audit_events_actor_identifier_check"
    CHECK (char_length("actor_identifier") BETWEEN 1 AND 64),
  ADD CONSTRAINT "audit_events_payload_object_check" CHECK (jsonb_typeof("payload") = 'object');

CREATE FUNCTION "audit_events_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_previous bytea;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'audit_immutable: audit events cannot be updated or deleted'
      USING ERRCODE = 'UE010';
  END IF;

  IF NEW."seq" = 1 THEN
    expected_previous := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  ELSE
    SELECT "event_hash" INTO expected_previous FROM "audit_events" WHERE "seq" = NEW."seq" - 1;
    IF expected_previous IS NULL THEN
      RAISE EXCEPTION 'audit_chain_broken: seq % has no predecessor', NEW."seq"
        USING ERRCODE = 'UE011';
    END IF;
  END IF;

  IF NEW."previous_hash" <> expected_previous THEN
    RAISE EXCEPTION 'audit_chain_broken: previous_hash of seq % does not match', NEW."seq"
      USING ERRCODE = 'UE011';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "audit_events_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_guard"();

-- TRUNCATE não dispara triggers de linha: bloqueado à parte. (A suíte de testes usa um
-- helper que desliga este trigger explicitamente para limpar o banco.)
CREATE FUNCTION "audit_events_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_immutable: audit events cannot be truncated' USING ERRCODE = 'UE010';
END;
$$;

CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_no_truncate"();
