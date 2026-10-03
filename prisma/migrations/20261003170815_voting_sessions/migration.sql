-- CreateTable
CREATE TABLE "voting_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "election_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "voting_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voting_sessions_token_hash_key" ON "voting_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "voting_sessions_election_id_idx" ON "voting_sessions"("election_id");

-- AddForeignKey
ALTER TABLE "voting_sessions" ADD CONSTRAINT "voting_sessions_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =====================================================================
-- Invariantes das sessões de votação. Ver docs/threat-model.md (T01, T03, T07).
-- =====================================================================

-- SHA-256 tem 32 bytes: impede gravar o token em claro por engano.
ALTER TABLE "voting_sessions"
  ADD CONSTRAINT "voting_sessions_token_hash_length_check" CHECK (octet_length("token_hash") = 32);

-- Regras:
--  * sessão só é criada com a eleição OPEN e não consumida (UE005 / UE006);
--  * só `consumed` muda, e só de false para true, com a eleição OPEN (UE006 / UE005);
--  * sessões nunca são apagadas (UE006).
CREATE FUNCTION "voting_sessions_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "election_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session_immutable: voting sessions cannot be deleted' USING ERRCODE = 'UE006';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."election_id", NEW."token_hash", NEW."expires_at")
       IS DISTINCT FROM (OLD."id", OLD."election_id", OLD."token_hash", OLD."expires_at")
       OR (OLD."consumed" AND NOT NEW."consumed") THEN
      RAISE EXCEPTION 'session_immutable: only consumed can change, and only to true'
        USING ERRCODE = 'UE006';
    END IF;
    IF OLD."consumed" = NEW."consumed" THEN
      RETURN NEW;
    END IF;
  ELSIF NEW."consumed" THEN
    RAISE EXCEPTION 'session_immutable: sessions must be created unconsumed' USING ERRCODE = 'UE006';
  END IF;

  SELECT "status" INTO current_status FROM "elections" WHERE "id" = NEW."election_id" FOR SHARE;
  IF current_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'election_not_open: sessions can only be created or consumed while the election is OPEN'
      USING ERRCODE = 'UE005';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "voting_sessions_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "voting_sessions"
  FOR EACH ROW EXECUTE FUNCTION "voting_sessions_guard"();

-- Balanço de habilitações -----------------------------------------------
-- Invariante: por eleição, nº de sessões == nº de eleitores com has_voted.
-- Verificada no COMMIT (constraint trigger adiada), então vale para a transação
-- inteira: criar sessão sem marcar eleitor (ballot stuffing) ou marcar eleitor
-- sem criar sessão faz o COMMIT falhar com UE007.
-- Custo: dois count(*) indexados por habilitação. Aceitável na escala do projeto.
CREATE INDEX "voters_election_id_has_voted_idx" ON "voters"("election_id") WHERE "has_voted";

CREATE FUNCTION "authorization_balance_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sessions_count bigint;
  authorized_count bigint;
BEGIN
  SELECT count(*) INTO sessions_count FROM "voting_sessions" WHERE "election_id" = NEW."election_id";
  SELECT count(*) INTO authorized_count
    FROM "voters" WHERE "election_id" = NEW."election_id" AND "has_voted";

  IF sessions_count <> authorized_count THEN
    RAISE EXCEPTION 'authorization_unbalanced: % sessions for % authorized voters',
      sessions_count, authorized_count
      USING ERRCODE = 'UE007';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "voting_sessions_balance"
  AFTER INSERT ON "voting_sessions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "authorization_balance_check"();

CREATE CONSTRAINT TRIGGER "voters_balance"
  AFTER UPDATE OF "has_voted" ON "voters"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."has_voted" AND NOT OLD."has_voted")
  EXECUTE FUNCTION "authorization_balance_check"();
