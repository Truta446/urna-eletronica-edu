# Revisão de hardening (Fase 9)

Revisão completa do sistema após as Fases 1–8, procurando vulnerabilidades, race conditions,
vazamento de dados, problemas arquiteturais e criptográficos, excesso de privilégios, logs perigosos
e erros de configuração.

Classificação: ✅ garantida · 🟡 parcialmente mitigada · 🔴 não garantida · ⚠️ risco conhecido.
"Corrigido" significa que há código **e** teste; nada aqui torna o sistema "seguro".

## Achados corrigidos nesta fase

### H1 — A aplicação conectava ao banco como superusuário 🔴 → ✅

**Problema.** Desde a Fase 1, `DATABASE_URL` usava a role dona do schema, que no Docker é
superusuário. Quem obtivesse as credenciais da aplicação (variável de ambiente vazada, RCE,
dependência maliciosa) poderia `ALTER TABLE … DISABLE TRIGGER`, apagar votos e reescrever a
auditoria. Várias garantias "do banco" das fases anteriores só valiam contra quem **não** tinha
essas credenciais.

**Correção.** Role `urna_app` (migration `app_role_least_privilege`):

- `SELECT, INSERT` nas tabelas que a aplicação lê e escreve;
- `UPDATE` **por coluna**, só onde há regra de negócio: `elections(status)`, `voters(has_voted)`, `voting_sessions(consumed)`;
- `DELETE` só em `idempotency_records`;
- nada de `UPDATE`/`DELETE` em `ballots`, `audit_events` e `tally_results`; nada de `TRUNCATE`, `ALTER` ou `CREATE`; sem acesso a `_prisma_migrations`.

As migrations usam `MIGRATION_DATABASE_URL` (dono). A senha da role é definida por
`scripts/setup-app-role.ts` (dentro de `npm run db:migrate`), nunca numa migration.

**Testes.** `test/integration/db-privileges.test.ts`: 14 operações perigosas executadas com as
credenciais da aplicação recebem `42501 insufficient_privilege`. A suíte inteira (≈500 testes) roda
com a aplicação conectada como `urna_app`, o que prova que os privilégios bastam.

**Risco residual.** O dono do schema (ou um superusuário do PostgreSQL) continua podendo tudo. Para
isso existem a detecção da Fase 7 (lacre assinado, Merkle root, cadeia de auditoria) e o
verificador externo. Ver também o achado A1 da Fase 10: com as credenciais da aplicação ainda é
possível habilitar eleitores ausentes.

### H2 — Sem limite de requisições 🔴 → 🟡

**Correção.** `@fastify/rate-limit`, global, por IP, `RATE_LIMIT_PER_MINUTE` (padrão 300; produção
recusa 0). Resposta `429 { error: { code: "RATE_LIMITED" } }`.

**Risco residual.** Contador em memória (uma instância). Atrás de proxy reverso, sem `trustProxy`
configurado, todos os clientes viram "o IP do proxy" e o limite vira negação de serviço. IPs ficam
na memória durante a janela, mas nunca nos logs.

### H3 — Sem headers defensivos 🟡 → ✅

**Correção.** Em toda resposta: `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Resource-Policy: same-origin` e `Cache-Control: no-store` quando a rota não define
outro.

### H4 — Sem timeout de requisição (slowloris) 🔴 → 🟡

**Correção.** `requestTimeout: 15s` no Fastify. **Risco residual:** proteção real contra DoS
volumétrico é de infraestrutura. Sem teste automatizado (exigiria sockets lentos reais).

### H5 — Configurações de desenvolvimento podiam chegar à produção 🔴 → 🟡

**Correção.** Com `NODE_ENV=production`, a validação da env **recusa iniciar** se houver:

- credencial com label `dev-*`;
- `LOG_LEVEL` `debug` ou `trace`;
- rate limit desligado;
- `DATABASE_URL` que não use a role `urna_app`.

**Risco residual.** Não detecta um pepper ou uma chave de assinatura copiados do `.env.example`.

### H6 — Logs de acesso permitiam correlação por horário (T16) 🔴 → 🟡

**Problema.** Todo `POST /elections/:id/voting-sessions` e todo `POST /ballots` gerava uma linha de
log com horário. Comparar os dois fluxos no agregador de logs aproxima eleitor e voto.

**Correção.** Essas duas rotas usam `logLevel: 'warn'`: sem log de acesso, só erros. Teste em
`hardening.test.ts`, que falha se o `logLevel` for removido (verificado por mutação).

**Risco residual.** O proxy de TLS e a infraestrutura continuam vendo IP e horário.

## Revisado, sem mudança necessária

| Área            | Conclusão                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Race conditions | Todas as transições críticas usam `UPDATE` condicional ou constraints. Testes concorrentes cobrem `open`, `close`, `tally`, habilitação, voto, candidatos e eleitores. Nenhum lock em memória.                 |
| Idempotência    | Escopo e fingerprint com HMAC usando o token como chave; registros apagados no fechamento.                                                                                                                     |
| Validação       | Todas as entradas passam por Zod com `strictObject`; datas exigem fuso; nomes sem caracteres de controle; `bodyLimit` de 16 KiB; só JSON.                                                                      |
| Erros           | 500 genérico; erros de banco logados só com códigos (sem "Failing row contains"); Zod sem valores.                                                                                                             |
| Criptografia    | Só `node:crypto` e bibliotecas consolidadas: HPKE (`@hpke/core`), Shamir (`shamir-secret-sharing`), JCS (`canonicalize`). Merkle conferida com vetores da RFC 6962. Comparações de segredo em tempo constante. |
| Aleatoriedade   | Só CSPRNG; `Math.random` proibido no lint.                                                                                                                                                                     |
| Dependências    | `npm audit`: 0. Vulnerabilidades transitivas do CLI do Prisma resolvidas com `overrides`.                                                                                                                      |
| CORS            | Não habilitado: browsers de outras origens não leem as respostas.                                                                                                                                              |
| Tipos           | Encontrado na Fase 8: `CryptoKey` virava `any` silencioso com `skipLibCheck`. Corrigido com tipos globais.                                                                                                     |

## Riscos que permanecem (documentados, não corrigidos)

| Risco                                                                                           | Classificação | Por quê                                                                                    |
| ----------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `xmin` compartilhado liga eleitor ↔ sessão ↔ voto para quem tem acesso físico durante a eleição | 🔴            | Propriedade do MVCC do PostgreSQL; exigiria separar bancos ou embaralhar inserções em lote |
| Servidor comprometido durante a eleição vê eleitor, token e escolha                             | 🔴            | Exige blind signatures (RFC 9474) e cifragem no cliente com provas de validade             |
| Segredos (pepper, chave de assinatura) em variável de ambiente                                  | ⚠️            | O correto seria um KMS/HSM                                                                 |
| Conexão com o banco sem TLS                                                                     | ⚠️            | Ambiente local; em produção, `sslmode=verify-full`                                         |
| Advisory lock global da auditoria serializa as escritas auditadas                               | ⚠️            | Correção por design; custo de desempenho                                                   |
| Rotação da chave de assinatura não guarda as chaves antigas                                     | ⚠️            | Resultados antigos ficariam inverificáveis após a troca                                    |
| Âncora da auditoria não é publicada automaticamente                                             | ⚠️            | O lacre assinado funciona como checkpoint, mas a publicação externa é manual               |
