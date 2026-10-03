-- AlterTable
ALTER TABLE "ballots" ADD COLUMN     "ciphertext" BYTEA,
ADD COLUMN     "encapsulated_key" BYTEA,
ALTER COLUMN "kind" DROP NOT NULL;

-- AlterTable
ALTER TABLE "elections" ADD COLUMN     "encryption_public_key" BYTEA;

-- AlterTable
ALTER TABLE "tally_results" ADD COLUMN     "decryption_key" BYTEA;

-- =====================================================================
-- Votos cifrados (v2). Funções de trigger SUBSTITUÍDAS com CREATE OR REPLACE:
-- migrations já aplicadas nunca são editadas.
-- =====================================================================

ALTER TABLE "elections"
  ADD CONSTRAINT "elections_encryption_public_key_length_check"
    CHECK ("encryption_public_key" IS NULL OR octet_length("encryption_public_key") = 32);

-- Exatamente um formato por voto: v1 (kind em claro) XOR v2 (ciphertext).
ALTER TABLE "ballots"
  ADD CONSTRAINT "ballots_format_check" CHECK (("kind" IS NULL) = ("ciphertext" IS NOT NULL)),
  ADD CONSTRAINT "ballots_encapsulated_key_pair_check"
    CHECK (("encapsulated_key" IS NULL) = ("ciphertext" IS NULL)),
  ADD CONSTRAINT "ballots_encrypted_no_candidate_check"
    CHECK ("ciphertext" IS NULL OR "candidate_id" IS NULL),
  ADD CONSTRAINT "ballots_encapsulated_key_length_check"
    CHECK ("encapsulated_key" IS NULL OR octet_length("encapsulated_key") = 32),
  -- Tamanho fixo: o comprimento do texto cifrado não pode revelar a escolha.
  ADD CONSTRAINT "ballots_ciphertext_length_check"
    CHECK ("ciphertext" IS NULL OR octet_length("ciphertext") = 33);

ALTER TABLE "tally_results"
  ADD CONSTRAINT "tally_results_decryption_key_length_check"
    CHECK ("decryption_key" IS NULL OR octet_length("decryption_key") = 32);

-- elections_guard: agora também congela encryption_public_key fora de DRAFT.
CREATE OR REPLACE FUNCTION "elections_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'invalid_election_transition: elections must be created as DRAFT'
        USING ERRCODE = 'UE001';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'election_frozen: only DRAFT elections can be deleted' USING ERRCODE = 'UE002';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" <> OLD."id" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'election_frozen: id and created_at are immutable' USING ERRCODE = 'UE002';
  END IF;

  IF OLD."status" <> 'DRAFT'
     AND (NEW."name", NEW."starts_at", NEW."ends_at", NEW."encryption_public_key")
         IS DISTINCT FROM (OLD."name", OLD."starts_at", OLD."ends_at", OLD."encryption_public_key") THEN
    RAISE EXCEPTION 'election_frozen: name, schedule and encryption key are immutable after DRAFT'
      USING ERRCODE = 'UE002';
  END IF;

  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT'  AND NEW."status" = 'OPEN')
    OR (OLD."status" = 'OPEN'   AND NEW."status" = 'CLOSED')
    OR (OLD."status" = 'CLOSED' AND NEW."status" = 'TALLIED')
  ) THEN
    RAISE EXCEPTION 'invalid_election_transition: % -> %', OLD."status", NEW."status"
      USING ERRCODE = 'UE001';
  END IF;

  RETURN NEW;
END;
$$;

-- ballots_guard: além do append-only, exige o formato da eleição:
-- eleição com chave pública => voto cifrado; sem chave => voto em claro (UE013).
CREATE OR REPLACE FUNCTION "ballots_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "election_status";
  election_key bytea;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ballot_immutable: ballots cannot be updated or deleted' USING ERRCODE = 'UE008';
  END IF;

  SELECT "status", "encryption_public_key" INTO current_status, election_key
    FROM "elections" WHERE "id" = NEW."election_id" FOR SHARE;
  IF current_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'election_not_open: ballots can only be cast while the election is OPEN'
      USING ERRCODE = 'UE005';
  END IF;
  IF (election_key IS NOT NULL) <> (NEW."ciphertext" IS NOT NULL) THEN
    RAISE EXCEPTION 'ballot_format_mismatch: ballot format does not match the election encryption mode'
      USING ERRCODE = 'UE013';
  END IF;
  RETURN NEW;
END;
$$;
