-- A role da aplicação podia INSERIR uma eleição já com created_before_audit = true e,
-- assim, escapar da checagem de completude da auditoria. INSERT agora é por COLUNA:
-- só os campos que a API realmente define.
REVOKE INSERT ON "elections" FROM "urna_app";
GRANT INSERT ("id", "name", "status", "starts_at", "ends_at", "created_at", "encryption_public_key")
  ON "elections" TO "urna_app";
