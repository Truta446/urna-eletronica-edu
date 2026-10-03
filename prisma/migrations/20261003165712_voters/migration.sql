-- CreateTable
CREATE TABLE "voters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "election_id" UUID NOT NULL,
    "identifier_hmac" BYTEA NOT NULL,
    "has_voted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voters_election_id_identifier_hmac_key" ON "voters"("election_id", "identifier_hmac");

-- AddForeignKey
ALTER TABLE "voters" ADD CONSTRAINT "voters_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =====================================================================
-- Invariantes de eleitores. Ver docs/threat-model.md (T01, T06, T07).
-- =====================================================================

-- HMAC-SHA256 tem exatamente 32 bytes; qualquer outra coisa (ex.: CPF em claro) é rejeitada.
ALTER TABLE "voters"
  ADD CONSTRAINT "voters_identifier_hmac_length_check" CHECK (octet_length("identifier_hmac") = 32);

-- Regras:
--  * cadastrar ou remover eleitor: só com a eleição em DRAFT (UE003);
--  * id, election_id, identifier_hmac e created_at são imutáveis (UE004);
--  * has_voted só vai de false para true, nunca volta (UE004);
--  * has_voted só vira true com a eleição em OPEN (UE005).
-- FOR SHARE serializa com transições de estado concorrentes da eleição.
CREATE FUNCTION "voters_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "election_status";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."election_id", NEW."identifier_hmac", NEW."created_at")
       IS DISTINCT FROM (OLD."id", OLD."election_id", OLD."identifier_hmac", OLD."created_at") THEN
      RAISE EXCEPTION 'voter_immutable: voter identity fields cannot change' USING ERRCODE = 'UE004';
    END IF;

    IF OLD."has_voted" AND NOT NEW."has_voted" THEN
      RAISE EXCEPTION 'voter_immutable: has_voted cannot be reverted' USING ERRCODE = 'UE004';
    END IF;

    IF NOT OLD."has_voted" AND NEW."has_voted" THEN
      SELECT "status" INTO current_status FROM "elections" WHERE "id" = NEW."election_id" FOR SHARE;
      IF current_status IS DISTINCT FROM 'OPEN' THEN
        RAISE EXCEPTION 'election_not_open: voters can only be authorized while the election is OPEN'
          USING ERRCODE = 'UE005';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  SELECT "status" INTO current_status
    FROM "elections"
   WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."election_id" ELSE NEW."election_id" END
   FOR SHARE;

  IF current_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'election_not_draft: voters can only be registered or removed while the election is DRAFT'
      USING ERRCODE = 'UE003';
  END IF;

  IF TG_OP = 'INSERT' AND NEW."has_voted" THEN
    RAISE EXCEPTION 'voter_immutable: voters must be registered with has_voted = false'
      USING ERRCODE = 'UE004';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "voters_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "voters"
  FOR EACH ROW EXECUTE FUNCTION "voters_guard"();
