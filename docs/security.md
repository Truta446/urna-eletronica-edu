# Segurança

Decisões de criptografia, segredos, logs e configuração. Para ameaças e classificação, ver
[threat-model.md](threat-model.md).

> **Segurança da aplicação ≠ segurança de um sistema eleitoral real.** Tudo aqui descreve o que este
> backend faz. Nada aqui torna o projeto adequado para uma eleição de verdade.

## Regras gerais

1. **Nenhuma criptografia caseira.** Só `node:crypto` e bibliotecas consolidadas e auditadas.
2. **Aleatoriedade só de CSPRNG.** `randomBytes`, `randomUUID`, `randomInt`. `Math.random` é bloqueado no lint.
3. **Segredos nunca no banco** que eles protegem.
4. **Entrada externa é hostil.** Body, params, headers e variáveis de ambiente passam por Zod.

## Identificador do eleitor (Fase 3 — implementado)

O CPF tem cerca de 10⁹ valores possíveis. Qualquer hash **sem segredo** é revertido por força bruta
em segundos. As opções:

| Opção                                         | Busca o eleitor?                   | Só o banco vaza            | Banco **e** pepper vazam    |
| --------------------------------------------- | ---------------------------------- | -------------------------- | --------------------------- |
| Guardar em claro                              | sim                                | ❌ lista exposta           | ❌                          |
| `SHA-256(cpf)`                                | sim                                | ❌ força bruta em segundos | ❌                          |
| `SHA-256(salt_por_linha ‖ cpf)`               | ❌ precisaria testar linha a linha | ok                         | ❌                          |
| Argon2/scrypt com salt por linha              | ❌ mesmo problema, e caro          | ok                         | 🟡                          |
| **`HMAC(chave_da_eleição, cpf)`** ← escolhido | ✅ índice `UNIQUE`                 | ✅ inútil sem o pepper     | ❌ segundos                 |
| scrypt/Argon2 com pepper e salt fixo          | ✅                                 | ✅                         | 🟡 ~1 CPU-ano para 10⁹ CPFs |

**Salt × pepper:**

- **Salt** é público e diferente por registro; serve para impedir tabelas pré-computadas. Aqui ele não
  funciona: precisamos _encontrar_ o eleitor a partir do CPF, então o valor guardado tem que ser
  determinístico.
- **Pepper** é secreto e fica **fora** do banco. É ele que torna o dump inútil.

**Implementação** (`src/security/voter-identifier.ts`):

```text
chave_eleição = HKDF-SHA256(ikm = pepper, salt = electionId, info = "urna-edu/voter-identifier/v1")
identifier_hmac = HMAC-SHA256(chave_eleição, cpf_normalizado)
```

- **Chave por eleição (HKDF):** o mesmo CPF gera valores diferentes em eleições diferentes. Um dump
  não permite saber que a mesma pessoa participou de duas eleições.
- **Normalização:** só dígitos, com dígitos verificadores validados. `529.982.247-25` e `52998224725`
  são o mesmo eleitor; `111.111.111-11` é rejeitado. A versão do `info` permite trocar o esquema no futuro.
- **Pepper:** `VOTER_ID_PEPPER`, base64url, pelo menos 32 bytes, validado por Zod na inicialização.
  Gerar com `npm run secret:generate`. Em produção ficaria num KMS/HSM, nunca no mesmo backup que o banco.
- **No banco:** `CHECK (octet_length(identifier_hmac) = 32)` impede gravar um CPF em claro por engano.
- **O CPF nunca** é armazenado, devolvido em resposta, incluído em mensagem de erro ou logado. Há
  testes para cada um desses casos.

**Rotação:** como o CPF original não está no banco, trocar o pepper exige recadastrar todos os
eleitores. Por isso a rotação natural é **entre eleições**: cada eleição já usa uma chave derivada
própria, e um pepper novo vale para eleições criadas depois da troca.

**Risco conhecido:** se o pepper vazar **junto** com o banco, o HMAC cai em segundos (espaço de 10⁹).
Um hash lento (scrypt/Argon2, ~50 ms) elevaria isso para cerca de 1 CPU-ano, ao custo de ~50 ms por
habilitação e minutos num cadastro em massa. Fica como endurecimento opcional.

## Tokens de votação (Fase 4 — implementado)

- `randomBytes(32)` → 256 bits de entropia, em base64url (43 caracteres).
- No banco: `SHA-256(token)`, com `CHECK` de 32 bytes e `UNIQUE`. Hash lento (bcrypt/argon2) é
  desnecessário: a entropia já é alta, e o hash rápido permite busca por índice.
- Expira em `VOTING_SESSION_TTL_SECONDS` (30–3600, padrão 300), **limitado ao fim da janela** da eleição.
- Uso único (consumo na Fase 5); triggers impedem alterar `token_hash`/`expires_at`, "desconsumir" ou apagar sessões.
- Exibido uma única vez, com `Cache-Control: no-store`; trafega só no header `Authorization`.
- Testes procuram o token em claro em **todas** as tabelas e nos logs.

### Relógio

Janela de votação e expiração usam o **relógio da aplicação** (`Clock`), passado como parâmetro ao
SQL, em vez de `now()` do banco: uma única fonte de tempo, controlável nos testes.
**Risco conhecido:** com várias instâncias da aplicação, relógios divergentes mudariam a expiração
na mesma medida (exige NTP).

### Balanço de habilitações

Uma _constraint trigger_ `DEFERRABLE INITIALLY DEFERRED` confere no COMMIT, por eleição, que
`nº de sessões == nº de eleitores com has_voted`. As duas contagens ficam em **um único comando
SQL**. A primeira versão usava dois comandos, e em `READ COMMITTED` cada um via um snapshot
diferente, o que gerava falso desbalanço sob concorrência. O teste de habilitações concorrentes
pegou esse bug, corrigido numa migration nova (a original não foi editada).

## Nullifier, commitment e idempotência (Fase 5 — implementado)

Todas as derivações estão em `src/security/ballot-crypto.ts` e usam separação de domínio
(`prefixo \0 dados`), com SHA-256 e HMAC-SHA256 apenas.

| Valor                 | Fórmula                                                            | Para quê                                                                       |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `nullifier`           | `SHA-256("urna-edu/nullifier/v1" ‖ token)`                         | `UNIQUE`: um token, no máximo um voto, garantido no banco sem FK para a sessão |
| `commitment`          | `SHA-256("urna-edu/ballot/v1" ‖ id ‖ election ‖ kind ‖ candidate)` | Folha da Merkle root (Fase 7); recalculável a partir da linha                  |
| `scope_key`           | `HMAC(token, "…idempotency-scope/v1" ‖ Idempotency-Key)`           | Chave do retry; ninguém sem o token a recalcula                                |
| `request_fingerprint` | `HMAC(token, "…request-fingerprint/v1" ‖ payload canônico)`        | Detecta a mesma chave com outro payload, sem revelar a escolha                 |

**Por que o nullifier não tem chave secreta:** o token tem 256 bits e nunca é armazenado. Sem ele,
`SHA-256(prefixo ‖ token)` e `SHA-256(token)` (o `token_hash` da sessão) não podem ser ligados.
Uma chave a mais seria um segredo a mais para gerenciar, sem ganho.

**Por que o fingerprint é um HMAC com o token:** só há poucos payloads possíveis (um por candidato,
mais branco e nulo). `SHA-256(payload)` seria revertido testando todos.

**Garantias no banco:** votos são append-only (trigger `UE008`), só entram com a eleição `OPEN`, a FK
composta `(election_id, candidate_id)` impede votar em candidato de outra eleição, um CHECK amarra
`kind` a `candidate_id`, e a constraint trigger adiada exige `votos == sessões consumidas` (`UE009`).
Somado à Fase 4: **votos == tokens usados ≤ eleitores habilitados**.

**Risco conhecido (provado em `test/adversarial/known-risks.test.ts`):** consumir o token e gravar o
voto na mesma transação dá `voting_sessions.xmin = ballots.xmin`. Isoladamente, isso liga uma sessão
(que não tem eleitor) a um voto. Combinado com o vínculo eleitor ↔ sessão da Fase 4, que some das
linhas vivas depois do voto mas fica na versão antiga da linha até o `VACUUM`, um observador com
acesso físico ao banco **durante** a eleição liga eleitor e voto.

## Versão 1 — voto em claro (Fases 5–7 — implementado)

A escolha fica legível no banco (`kind` + `candidate_id`), mas sem nenhum vínculo com o eleitor. Serve
para entender o domínio e testar concorrência, idempotência e apuração.

**Classificação:** sigilo contra quem lê o banco 🔴 não garantido. Anonimato (não vinculação) contra
dump lógico 🟡 parcialmente mitigado. Contra acesso físico durante a eleição 🔴 não garantido (xmin).

## Versão 2 — voto cifrado (Fase 8, proposta)

| Pergunta                                  | Proposta                                                                                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O que é cifrado**                       | A escolha canônica com padding de tamanho fixo (o tamanho do ciphertext não pode revelar a escolha).                                                                                                                                            |
| **Algoritmo**                             | **HPKE** (RFC 9180): DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM, via biblioteca auditada. AAD = `electionId ‖ versão do formato`, para impedir mover um ballot de uma eleição para outra.                                           |
| **Onde ficam as chaves**                  | O servidor só tem a **chave pública** da eleição. A privada é gerada offline e dividida entre _trustees_ com **Shamir Secret Sharing** (k de n), usando biblioteca auditada. Ninguém sozinho consegue decifrar.                                 |
| **Rotação**                               | Um par de chaves **por eleição**, sem rotação durante a votação (rotacionar no meio exigiria apurar com duas chaves). Chaves de assinatura (Ed25519) e de HMAC têm identificador de versão (`kid`) e podem rotacionar entre eleições.           |
| **Anti-adulteração**                      | O AEAD (GCM) detecta alteração do ciphertext. O commitment passa a ser `SHA-256(ciphertext)`. A Merkle root assinada no fechamento detecta inclusão, remoção ou troca de ballots.                                                               |
| **Apuração**                              | Após `CLOSED`, k trustees reconstroem a chave privada em ambiente isolado, decifram, apuram com a mesma função pura da versão 1 e publicam o resultado com a Merkle root.                                                                       |
| **Metadados que comprometem o anonimato** | Timestamps; IDs ordenados por tempo (UUID v7, sequences); ordem física (`ctid`, `xmin`, WAL); tamanho do ciphertext; IP e horário em logs; eventos de auditoria por voto; o próprio `idempotency_records` se guardasse hash simples do payload. |

**Alternativa estudada e descartada:** cifragem homomórfica (ElGamal exponencial, como no
ElectionGuard/Helios). Permite apurar sem decifrar votos individuais, mas exige provas de conhecimento
zero para garantir que cada ballot é válido. Fica como referência, fora do escopo.

## Audit log (Fase 6 — implementado)

```text
eventHash = SHA-256( JCS({seq, eventType, actorType, actorIdentifier, electionId, payload, createdAt})
                     ‖ previousHash )
previousHash do evento 1 = 32 bytes zero
```

- **JSON canônico (RFC 8785)** via `canonicalize` (biblioteca do coautor da RFC). O payload volta do
  `jsonb` com as chaves em outra ordem e mesmo assim gera os mesmos bytes. Payloads só aceitam
  primitivos, para evitar as armadilhas de serialização de números não inteiros.
- **`seq` entra no hash:** trocar a posição de um evento muda o hash dele.
- **Escrita na mesma transação da operação** (`appendAuditEvent(tx, …)`): o evento existe se e
  somente se a operação foi confirmada. Testado: operações rejeitadas não deixam evento.
- **Serialização:** `pg_advisory_xact_lock` até o COMMIT, sempre como **último** lock da transação
  (evita deadlock). Custo: todas as escritas auditadas, inclusive as habilitações, passam por esse lock.
- **No banco:** `INSERT` exige `seq` contíguo e `previous_hash` igual ao `event_hash` do anterior
  (`UE011`). `UPDATE`, `DELETE` e `TRUNCATE` são bloqueados (`UE010`). Nem a role da aplicação
  consegue bifurcar a cadeia. Teste de mutação: sem o advisory lock, o banco ainda impede a
  bifurcação; a escrita perdedora falha (disponibilidade), mas a cadeia continua íntegra.
- **`verifyAuditChain()`** (`src/modules/audit/domain/audit-chain.ts`) é uma função pura e
  incremental (verifica em páginas de 1000). Detecta:

| Ataque                                                  | Resultado                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Evento alterado (payload, ator, horário, tipo, eleição) | `HASH_MISMATCH` no evento                                       |
| Evento alterado **com o hash dele recalculado**         | `BROKEN_LINK` no evento seguinte                                |
| Evento removido no meio (ou o primeiro)                 | `SEQUENCE_GAP`                                                  |
| Ordem alterada (troca de `seq`)                         | falha no primeiro evento afetado                                |
| Últimos eventos apagados                                | ❌ **não detectado** sem âncora → `ANCHOR_NOT_FOUND` com âncora |
| Cadeia inteira reescrita de forma consistente           | ❌ **não detectado** sem âncora → `ANCHOR_MISMATCH` com âncora  |

**Âncora:** `GET /admin/audit/verify?anchorSeq=N&anchorHash=…` confere que o evento `N` existe e
tem aquele hash. A âncora só funciona se for publicada **fora** do banco, em lugar que o atacante não
controla (outro sistema, e-mail para fiscais, papel). Este projeto não automatiza a publicação.

**O que não entra no log:**

- `VOTER_AUTHORIZED` não leva o id do eleitor. O horário do evento é o mesmo instante usado no
  `expires_at` da sessão, então com o id do eleitor um dump lógico ligaria eleitor e sessão.
- Não há evento por voto. `BALLOT_BOX_SEALED` registra, no fechamento, as contagens finais
  (votos, sessões consumidas, habilitados, cadastrados, habilitados sem voto).
- Nenhum CPF, HMAC de CPF, token, id de voto ou escolha. Testado varrendo a tabela inteira.

## Logs e redaction (Fase 1 — implementado)

Duas camadas, ambas cobertas por `test/unit/redaction.test.ts`:

1. **Whitelist no log de requisição** (`serializeRequest`): só `id`, `method` e `url` **sem query
   string**. Headers, body e **IP do cliente** ficam de fora. IP + horário em `/voting-sessions` e
   `/ballots` bastaria para correlacionar eleitor e voto.
2. **Redaction por caminho** (pino `redact`): `token`, `authorization`, `idempotencyKey`,
   `voterIdentifier`, `choice`, `pepper`, `secret`, `privateKey` e `password` viram `[REDACTED]`
   se algum código os logar por engano.

Também implementado:

- Query logging do Prisma **desligado** (os parâmetros conteriam votos).
- Erros 500 respondem com mensagem genérica; detalhes só no log do servidor.
- Erros de validação listam caminho e mensagem, **nunca o valor recebido**.
- Validação de env lista os nomes das variáveis inválidas, **nunca os valores**.

Nunca logar: voto, conteúdo decifrado, token completo, segredos, chaves privadas, identificador do eleitor.

## Credenciais de operadores (Fases 2 e 4 — implementado)

- `ADMIN_CREDENTIALS` e `POLL_WORKER_CREDENTIALS`, ambos `label:sha256hex,…`. A configuração **nunca**
  contém o token em si; um vazamento do `.env` não dá acesso.
- **Separação de funções:** admin configura eleições mas não habilita eleitores; mesário habilita mas
  não acessa `/admin`. A env rejeita um mesmo token nos dois papéis.
- `npm run operator:token -- <label>` gera token (256 bits) e a linha de configuração.
- Comparação com `timingSafeEqual` contra **todas** as credenciais, sem sair no primeiro acerto.
- Formato estrito `Authorization: Bearer <43 caracteres base64url>`; qualquer variação dá `401` idêntico.
- A autenticação roda antes da validação do body, para não revelar o formato da API a quem não está autenticado.
- O `label` será o `actorIdentifier` dos eventos de auditoria (Fase 6).
- **Limitações:** sem rotação automática, sem expiração, sem MFA. Revogar = remover a linha e reiniciar.

## Erros de banco nos logs (Fase 2 — implementado)

Mensagens do PostgreSQL de violação de CHECK incluem `Failing row contains (…)`, ou seja, a linha
inteira. Se um erro desses chegasse ao log como objeto completo, numa tabela de votos o log teria o
voto. O handler de 500 loga erros do Prisma só com `name`, código Prisma e SQLSTATE.
`test/integration/error-logging.test.ts` prova isso, e falha se a proteção for removida.

## Configuração segura (Fase 1 — implementado)

| Item                | Valor                                          | Motivo                                                                     |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `bodyLimit`         | 16 KiB                                         | Nenhum payload legítimo chega perto disso                                  |
| `requestIdHeader`   | desligado                                      | Não aceitar request id vindo do cliente (evita injeção em logs e colisões) |
| `genReqId`          | `randomUUID()`                                 | IDs imprevisíveis                                                          |
| `trustProxy`        | `false`                                        | Não confiar em `X-Forwarded-*` sem proxy configurado                       |
| Postgres no compose | `127.0.0.1:5440`                               | Não expor o banco na rede local                                            |
| Testes              | recusam banco cujo nome não termina em `_test` | A suíte trunca tabelas                                                     |
| Content-type        | só `application/json`                          | Parser de `text/plain` removido; outros tipos dão `415`                    |
| Bodies              | `z.strictObject`                               | Campos desconhecidos (`status`, `id`) dão `400`: sem mass assignment       |

## Pendências (fases futuras)

- Roles do PostgreSQL com menor privilégio (app sem `UPDATE`/`DELETE` em `ballots` e `audit_events`) — Fase 5/9
- Rate limiting — Fase 9
- Headers de segurança HTTP — Fase 9
- Autenticação de mesários — Fase 4
