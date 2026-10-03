-- AlterEnum
ALTER TYPE "audit_event_type" ADD VALUE 'TALLY_FAILED';

-- CreateTable
CREATE TABLE "tally_results" (
    "election_id" UUID NOT NULL,
    "result" JSONB NOT NULL,
    "merkle_root" BYTEA NOT NULL,
    "result_hash" BYTEA NOT NULL,
    "signature" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tally_results_pkey" PRIMARY KEY ("election_id")
);

-- AddForeignKey
ALTER TABLE "tally_results" ADD CONSTRAINT "tally_results_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =====================================================================
-- Resultado da apuração: gravado uma vez, nunca alterado.
-- =====================================================================
ALTER TABLE "tally_results"
  ADD CONSTRAINT "tally_results_merkle_root_length_check" CHECK (octet_length("merkle_root") = 32),
  ADD CONSTRAINT "tally_results_result_hash_length_check" CHECK (octet_length("result_hash") = 32),
  ADD CONSTRAINT "tally_results_result_object_check" CHECK (jsonb_typeof("result") = 'object');

CREATE FUNCTION "tally_results_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "election_status";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tally_immutable: tally results cannot be updated or deleted' USING ERRCODE = 'UE012';
  END IF;
  SELECT "status" INTO current_status FROM "elections" WHERE "id" = NEW."election_id" FOR SHARE;
  IF current_status IS DISTINCT FROM 'TALLIED' THEN
    RAISE EXCEPTION 'tally_immutable: results are written in the same transaction that marks the election TALLIED'
      USING ERRCODE = 'UE012';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "tally_results_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "tally_results"
  FOR EACH ROW EXECUTE FUNCTION "tally_results_guard"();
