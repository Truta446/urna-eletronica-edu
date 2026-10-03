-- CreateEnum
CREATE TYPE "election_status" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'TALLIED');

-- CreateTable
CREATE TABLE "elections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "status" "election_status" NOT NULL DEFAULT 'DRAFT',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "elections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "election_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "candidates_election_id_number_key" ON "candidates"("election_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_election_id_id_key" ON "candidates"("election_id", "id");

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =====================================================================
-- Invariantes que o Prisma não expressa. Escritas à mão, revisadas.
-- Códigos SQLSTATE próprios (classe "UE") permitem à aplicação mapear
-- cada violação para um erro HTTP sem depender do texto da mensagem.
-- =====================================================================

-- Integridade de valores ------------------------------------------------
ALTER TABLE "elections"
  ADD CONSTRAINT "elections_schedule_check" CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "elections_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 200);

ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_number_check" CHECK ("number" BETWEEN 1 AND 99999),
  ADD CONSTRAINT "candidates_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 200);

-- Máquina de estados da eleição ----------------------------------------
-- DRAFT -> OPEN -> CLOSED -> TALLIED, sem voltar. Fora de DRAFT, nome e
-- janela de votação ficam congelados. Só eleições em DRAFT podem ser apagadas.
CREATE FUNCTION "elections_guard"() RETURNS trigger
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
     AND (NEW."name", NEW."starts_at", NEW."ends_at")
         IS DISTINCT FROM (OLD."name", OLD."starts_at", OLD."ends_at") THEN
    RAISE EXCEPTION 'election_frozen: name and schedule are immutable after DRAFT'
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

CREATE TRIGGER "elections_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "elections"
  FOR EACH ROW EXECUTE FUNCTION "elections_guard"();

-- Candidatos só mudam com a eleição em DRAFT ---------------------------
-- FOR SHARE conflita com o lock do UPDATE que abre a eleição: um INSERT de
-- candidato concorrente com a abertura é serializado. Ou o candidato entra
-- antes da abertura, ou é rejeitado depois dela.
CREATE FUNCTION "candidates_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "election_status";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."election_id" <> OLD."election_id" THEN
    RAISE EXCEPTION 'election_not_draft: candidates cannot move between elections'
      USING ERRCODE = 'UE003';
  END IF;

  SELECT "status" INTO current_status
    FROM "elections"
   WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."election_id" ELSE NEW."election_id" END
   FOR SHARE;

  IF current_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'election_not_draft: candidates can only change while the election is DRAFT'
      USING ERRCODE = 'UE003';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "candidates_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "candidates"
  FOR EACH ROW EXECUTE FUNCTION "candidates_guard"();
