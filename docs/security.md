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

## Identificador do eleitor (Fase 3)

| Opção                                     | Problema                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Guardar em claro                          | Vazamento do banco expõe a lista de eleitores                                                       |
| `SHA-256(cpf)`                            | ~10⁹ CPFs possíveis: força bruta em segundos                                                        |
| `SHA-256(salt_por_linha ‖ cpf)`           | Impossível buscar o eleitor sem testar linha a linha                                                |
| Argon2 com salt por linha                 | Mesmo problema de busca, e caro                                                                     |
| **`HMAC-SHA256(pepper, normalize(cpf))`** | ✅ Determinístico (permite índice `UNIQUE` e busca); sem o pepper, o dump é inútil para força bruta |

- **Pepper**: 32 bytes aleatórios em variável de ambiente (validada por Zod). Em produção, viria de um KMS/HSM.
- **Normalização** antes do HMAC (só dígitos), para `123.456.789-09` e `12345678909` darem o mesmo valor.
- **Rotação do pepper** exige recalcular todos os HMACs a partir dos identificadores originais, que não
  estão no banco. Na prática, um pepper por eleição.

## Tokens de votação (Fase 4)

- `randomBytes(32)` → 256 bits de entropia, em base64url.
- No banco: `SHA-256(token)`. Hash lento (bcrypt/argon2) é desnecessário: a entropia já é alta, e o
  hash rápido permite busca por índice.
- Expiração curta, uso único, exibido uma vez.
- Trafega só no header `Authorization`.

## Nullifier e commitment (Fase 5)

- `nullifier = HMAC-SHA256(k_nullifier, token)`, com `UNIQUE` em `ballots`. Garante no banco que um
  token gera no máximo um voto, sem FK para `voting_sessions`. Não é possível ligar o `nullifier` ao
  `token_hash` sem o token em claro.
- `commitment = SHA-256(ballot_id ‖ election_id ‖ escolha canônica ‖ nonce)`. Entra na Merkle root.

## Versão 1 — voto em claro (Fases 5–7)

A escolha fica legível no banco (`kind` + `candidate_id`), mas sem nenhum vínculo com o eleitor. Serve
para entender o domínio e testar concorrência, idempotência e apuração.

**Classificação:** sigilo contra quem lê o banco 🔴 não garantido. Anonimato (não vinculação) 🟡
parcialmente mitigado.

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

## Audit log (Fase 6)

- `eventHash = SHA-256(JSON canônico (RFC 8785) do evento ‖ previousHash)`; o primeiro evento usa um hash gênese fixo.
- `seq bigint` contíguo e `UNIQUE`; escrita serializada com `pg_advisory_xact_lock`.
- `verifyAuditChain()` detecta edição, remoção e reordenação.
- **Limitações:** truncamento da cauda e reescrita completa da cadeia não são detectáveis sem uma
  âncora externa (hash do último evento publicado fora do banco, checkpoints assinados).
- Eventos **nunca** contêm escolha de voto, token, identificador de eleitor nem dados que permitam
  correlacionar habilitação com voto.

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

## Credenciais de administrador (Fase 2 — implementado)

- `ADMIN_CREDENTIALS=label:sha256hex,…`. A configuração **nunca** contém o token em si; um vazamento do `.env` não dá acesso.
- `npm run admin:token -- <label>` gera token (256 bits) e a linha de configuração.
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
