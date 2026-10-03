# Relatório de ataque (Fase 10)

Nesta fase o papel foi de **atacante**: tentar votar duas vezes, criar voto sem eleitor válido,
trocar, alterar ou apagar votos, alterar a apuração, reutilizar token e ligar eleitor a voto.
Para cada vulnerabilidade encontrada: o ataque, por que funcionava, a correção e o teste de
regressão. O teste de regressão **falhava antes da correção**; cada ataque foi provado primeiro.

Atacantes considerados:

| Atacante                              | Tem                                                         |
| ------------------------------------- | ----------------------------------------------------------- |
| Externo                               | Acesso HTTP, nenhum segredo                                 |
| Eleitor                               | Um token de votação                                         |
| Mesário / admin                       | Sua credencial de operador                                  |
| **Credenciais do banco da aplicação** | `DATABASE_URL` (role `urna_app`), sem a chave de assinatura |
| DBA / superusuário                    | Tudo no PostgreSQL, sem a chave de assinatura               |
| Servidor comprometido                 | Tudo, inclusive as chaves                                   |

---

## Vulnerabilidades encontradas e corrigidas

### A1 — Enchimento de urna com as credenciais do banco da aplicação

**Ataque.** Com `urna_app`, para cada eleitor **ausente**, numa transação: `UPDATE voters SET has_voted = true`,
`INSERT` de uma sessão, `UPDATE … SET consumed = true`, `INSERT` de um voto com commitment correto.

**Por que funcionava.** São exatamente as operações que a aplicação precisa fazer, então a role de
menor privilégio (Fase 9) as permite. E todos os balanços continuam fechando: sessões == habilitados,
votos == sessões consumidas. O lacre (Fase 7) só garante que nada mudou **depois** do fechamento.
O enchimento acontece antes, e a apuração aceitava o resultado.

**Correção.** Cada habilitação grava em `VOTER_AUTHORIZED` um **nonce aleatório assinado pelo servidor**
(Ed25519, declaração `urna-edu/authorization/v1`, sem referência a eleitor ou sessão). Na apuração,
o número de eventos com assinatura válida e nonce único precisa ser igual ao número de eleitores
habilitados (`AUTHORIZATION_EVENTS_MISMATCH`). Quem tem só o banco não fabrica assinaturas, e copiar
um evento legítimo repete o nonce.

**Testes.** `test/adversarial/attack-ballot-stuffing.test.ts`: o ataque funciona no nível do banco,
e a apuração o detecta, inclusive quando o atacante forja eventos com a cadeia de hashes correta.

**Risco residual.** 🔴 Quem tem **também** a chave de assinatura (servidor comprometido) consegue
encher a urna sem deixar rastro no sistema. Só uma conferência externa (caderno de votação físico ×
lista de habilitados) detectaria.

### A2 — Correlação exata por horário entre auditoria e sessões

**Ataque.** `SELECT … FROM audit_events a JOIN voting_sessions s ON s.expires_at = a.created_at + TTL`.

**Por que funcionava.** O evento `VOTER_AUTHORIZED` guardava o instante exato da habilitação, e a
sessão guardava `expires_at = mesmo instante + TTL`, com milissegundos. O `JOIN` ligava "habilitado
pelo mesário X às 10:03:21.457" a uma sessão. A sessão, pelo `xmin` compartilhado com o voto (mesma
transação), leva ao voto. Esse caminho sobrevive ao `VACUUM`, que apaga o vínculo eleitor ↔ sessão.
Quem sabe quem estava na mesa às 10:03 (o mesário, o caderno de presença) chega ao voto.

**Correção.** `expires_at` é arredondado **para cima** até o minuto cheio. O token continua valendo
pelo menos o TTL; o instante exato da habilitação deixa de ser recuperável pela sessão.

**Testes.** `test/adversarial/attack-timing-correlation.test.ts`: antes, 6 de 6 sessões casavam;
depois, nenhuma. Também confere a granularidade de minuto e que a validade nunca fica menor que o TTL.

**Risco residual.** 🟡 Com pouco movimento, uma janela de um minuto ainda pode ter um só eleitor. A
ordem de inserção continua visível para quem tem acesso físico.

### A3 — Lacre duplicado

**Ataque.** Com `urna_app`, anexar um segundo `BALLOT_BOX_SEALED` à cadeia de auditoria (a role pode
inserir eventos, e o atacante sabe calcular o encadeamento).

**Por que funcionava.** A apuração lia o lacre com `findFirst`, sem ordem: com dois lacres, "qual
vale" dependia do plano de execução do banco.

**Correção.** A apuração exige **exatamente um** lacre por eleição (`SEAL_DUPLICATED`).

**Teste.** `test/adversarial/attack-forged-results.test.ts`.

### A4 — Resultado forjado gravado direto em `tally_results`

**Ataque.** Com `urna_app`: `UPDATE elections SET status = 'TALLIED'` (a coluna que a role pode
alterar; a transição `CLOSED → TALLIED` é legal para o trigger) e `INSERT` de um `tally_results` com
resultado inventado.

**Por que funcionava.** O banco não tem como validar uma assinatura Ed25519, e a API publicava o que
estivesse na tabela. Um verificador externo detectaria, mas o servidor serviria o resultado falso.

**Correção.** Antes de publicar (`GET /elections/:id/tally` e `/ballots`), o servidor confere a
assinatura do lacre, o hash e a assinatura do resultado. Se falhar: `409 INTEGRITY_FAILURE`, e nada
é servido.

**Teste.** `test/adversarial/attack-forged-results.test.ts`.

---

## Tentativas que não funcionaram

| Objetivo                | Tentativa                                                   | Resultado                                                        | Onde está provado                                         |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| Votar duas vezes        | Habilitar de novo; 25 habilitações simultâneas              | 409; 1 token                                                     | `authorization.test.ts`, INV-1                            |
| Votar duas vezes        | Reusar o token; 300 requisições simultâneas                 | 1 voto, zero 5xx                                                 | INV-2, INV-7, `ballot-abuse.test.ts`                      |
| Votar duas vezes        | Retry com a mesma chave e outra escolha                     | 422; voto original mantido                                       | INV-6, `ballot-abuse.test.ts`                             |
| Voto sem eleitor válido | 1000 tokens aleatórios                                      | 401, nada consumido                                              | `ballot-abuse.test.ts`                                    |
| Voto sem eleitor válido | Token de admin/mesário como token de voto                   | 401                                                              | `attack-catalog.test.ts`                                  |
| Voto sem eleitor válido | `INSERT` direto em `ballots` sem consumir sessão            | `UE009` no COMMIT                                                | INV-2                                                     |
| Trocar candidato        | Editar candidatos após a abertura                           | trigger `UE003`; `urna_app` recebe 42501                         | `database-constraints`, `db-privileges`                   |
| Trocar candidato        | Candidato de outra eleição                                  | FK composta (23503)                                              | `database-constraints`                                    |
| Alterar voto            | Via API                                                     | Não existe endpoint                                              | —                                                         |
| Alterar voto            | `UPDATE ballots` com `urna_app`                             | 42501                                                            | `db-privileges.test.ts`                                   |
| Alterar voto            | Superusuário, com e sem recalcular o commitment             | Apuração recusa (`COMMITMENT_MISMATCH` / `MERKLE_ROOT_MISMATCH`) | `tally-invariants.test.ts`                                |
| Alterar voto (v2)       | Mudar 1 bit do texto cifrado; mover para outro voto/eleição | AEAD recusa (AAD)                                                | `ballot-encryption.test.ts`, `encrypted-election.test.ts` |
| Apagar voto             | `DELETE` com `urna_app` / superusuário                      | 42501 / apuração recusa (`BALLOT_COUNT_MISMATCH`)                | `db-privileges`, `tally-invariants`                       |
| Alterar apuração        | Inflar votos no resultado publicado                         | Verificador independente recusa                                  | `tally.test.ts`                                           |
| Alterar apuração        | Editar o lacre na auditoria                                 | Assinatura inválida                                              | `tally-invariants.test.ts`                                |
| Alterar apuração        | Apurar duas vezes / em paralelo                             | Exatamente uma apuração                                          | `tally.test.ts`                                           |
| Reutilizar token        | Após o voto; após expirar; após o fechamento                | 409 / 401 / 401                                                  | `ballots.test.ts`                                         |
| Reutilizar token        | Token de outra eleição                                      | 422, nada consumido                                              | `ballots.test.ts`                                         |
| Ligar eleitor a voto    | Pelos endpoints públicos                                    | Nada de eleitor, sessão ou horário é público                     | `attack-catalog.test.ts`                                  |
| Ligar eleitor a voto    | Pela auditoria                                              | Sem eleitor em `VOTER_AUTHORIZED`; sem evento por voto           | `audit.test.ts`                                           |
| Ligar eleitor a voto    | Por logs de acesso                                          | Rotas sensíveis sem log de acesso                                | `hardening.test.ts`                                       |

## Ataques que continuam funcionando (riscos conhecidos)

| Ataque                                   | Quem                                              | Por quê                                                                                                                                               | Classificação                       |
| ---------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Ligar eleitor ↔ sessão ↔ voto por `xmin` | Acesso físico ao banco durante a eleição          | Propriedade do MVCC do PostgreSQL                                                                                                                     | 🔴 provado em `known-risks.test.ts` |
| Ler eleitor, token e escolha em memória  | Servidor comprometido                             | Exige blind signatures + cifragem no cliente                                                                                                          | 🔴                                  |
| Encher a urna sem rastro                 | Servidor comprometido (tem a chave de assinatura) | A assinatura é a única prova de autenticidade                                                                                                         | 🔴                                  |
| Encerrar a eleição antes de `endsAt`     | `urna_app` (`UPDATE status`)                      | A regra de horário está só na aplicação (relógio da aplicação); o resultado é detectável (sem lacre, a apuração recusa), mas a eleição fica arruinada | 🟡                                  |
| Votar por eleitor ausente                | Mesário em conluio                                | Falha procedimental, fora do software                                                                                                                 | ⚠️                                  |
| Correlação por janela de minuto          | Quem tem auditoria + banco                        | Com pouco movimento, poucos candidatos por janela                                                                                                     | 🟡                                  |
| Coerção                                  | Coagidor presente                                 | Votação remota                                                                                                                                        | ⚠️                                  |
