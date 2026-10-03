-- Eleições criadas ANTES de existir auditoria (Fases 1–5, só em bancos de desenvolvimento)
-- não têm ELECTION_CREATED. A verificação de completude ("toda eleição tem a própria
-- cadeia") precisa distingui-las de uma eleição cuja cadeia foi APAGADA.
-- Marcadas uma única vez, aqui. A role da aplicação só pode alterar `status` (Fase 9),
-- então não consegue marcar uma eleição nova como "anterior à auditoria".
ALTER TABLE "elections" ADD COLUMN "created_before_audit" BOOLEAN NOT NULL DEFAULT false;

UPDATE "elections" e SET "created_before_audit" = true
 WHERE NOT EXISTS (SELECT 1 FROM "audit_events" a
                    WHERE a."election_id" = e."id" AND a."event_type" = 'ELECTION_CREATED');
