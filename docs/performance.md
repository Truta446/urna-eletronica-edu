# Performance

Validação feita depois da Fase 10: medir antes de otimizar, corrigir só o que os números mostraram,
e conferir que nenhuma garantia de segurança foi perdida no caminho.

## Como medir

```bash
npm run bench -- 1000 10000 50000      # BENCH_CONCURRENCY=16 por padrão
```

- Banco **próprio** (`urna_bench`), truncado a cada cenário.
- Eleitores cadastrados em massa direto no banco (o cadastro não é o alvo).
- Habilitação e voto pela **API real** (Fastify + Prisma + PostgreSQL), 16 em paralelo, dentro do
  mesmo processo: mede aplicação + banco, sem rede. Relógio simulado.
- Latências separadas por faixa de preenchimento da eleição (0–20%, …, 80–100%), para ver se o custo
  **cresce** à medida que a eleição enche.
- Depois: fechamento (lacre), apuração e verificação independente do resultado. O benchmark falha se
  a verificação não confere.

Máquina: notebook de desenvolvimento, PostgreSQL 18 em Docker. Os números servem para **comparar
versões**, não como capacidade absoluta.

## Linha de base: o custo crescia com a eleição

| 50.000 eleitores | eleição 0–20% | 80–100%    |
| ---------------- | ------------- | ---------- |
| habilitação p50  | 53 ms         | **136 ms** |
| voto p50         | 20 ms         | **48 ms**  |

Vazão: 239 eleitores/s com 10 mil, **119/s com 50 mil**. Votação de 50 mil: **420 s**.

**Causa (medida, não suposta):** os balanços das Fases 4 e 5 ("sessões == habilitados",
"votos == sessões consumidas") faziam `count(*)` sobre a eleição inteira. Eram 4 contagens por
habilitação e 4 por voto, cada uma levando 10–40 ms com 50 mil linhas. Custo O(n) por operação,
O(n²) na eleição.

## Rodada 1: contadores mantidos pelo banco

Migration `balance_counters`: triggers incrementam contadores, e os balanços comparam dois números (O(1)).

- **A garantia continua igual** (a suíte inteira, inclusive os testes de enchimento de urna, passa).
- As funções que incrementam são `SECURITY DEFINER`; a role da aplicação só tem `SELECT` nos
  contadores. Um atacante com `urna_app` não consegue acertá-los à mão (testado: `42501`).

Resultado: habilitação **plana em 16 ms** e vazão de 244/s com 50 mil. **Mas o voto piorou**
(p50 39 ms, p95 ~100 ms) e a vazão travou em ~250/s em qualquer tamanho. Todo voto incrementava a
**mesma linha** e segurava o lock dela até o COMMIT: votos em fila. Uma transação de ~4 ms com lock
dá um teto de ~250/s, exatamente o observado.

## Rodada 2: contadores fragmentados, e um deadlock no caminho

Migration `sharded_balance_counters`: 16 linhas por eleição; cada incremento escolhia uma ao acaso
e os balanços somavam as 16.

**A suíte pegou um deadlock** (intermitente, confirmado nos logs do PostgreSQL:
`deadlock detected … relation "ballot_counters"`). Um voto travava o shard X (consumida) e depois o
Y (voto); outro voto, Y e depois X. Ordem de lock invertida, ciclo de espera.

Correção (migration `counters_single_shard_per_transaction`): o shard passou a ser derivado do **id
da transação**. Os dois incrementos de uma transação caem na mesma linha, e nenhuma transação segura
dois shards, então não há ciclo. Verificado: zero deadlocks em 3 rodadas da suíte e no benchmark
completo.

## Resultado final

|                             | 1.000            | 10.000           | 50.000                |
| --------------------------- | ---------------- | ---------------- | --------------------- |
| vazão (eleitores/s)         | 293              | 320              | **320**               |
| habilitação p50 / p95       | 34–44 / 39–56 ms | 34–36 / 41–45 ms | **34 / 41–59 ms**     |
| voto p50 / p95              | 14–18 / 17–27 ms | 14–15 / 19–20 ms | **14 / 19–32 ms**     |
| votação completa            | 3,4 s            | 31 s             | **156 s** (era 420 s) |
| fechamento (lacre + Merkle) | 27 ms            | 69 ms            | 351 ms                |
| apuração                    | 144 ms           | 825 ms           | 3,9 s                 |
| verificação independente    | 13 ms            | 74 ms            | 343 ms                |

**A latência não cresce mais com o tamanho da eleição.** Vazão 2,7× maior com 50 mil eleitores; voto
p95 de 56 ms para 19 ms.

## Gargalos que permanecem (por design)

| Gargalo                                            | Por quê                                                                                                             | Possível melhoria                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Habilitação ~34 ms com 16 em paralelo; teto ~320/s | O **advisory lock global** da auditoria serializa as escritas para manter **uma** cadeia (decisão da Fase 6)        | Uma cadeia por eleição, ancorada numa cadeia global: muda o formato da auditoria |
| Apuração ~4 s com 50 mil                           | Verifica a cadeia inteira de auditoria e ~50 mil assinaturas Ed25519 das habilitações (Fase 10, A1) antes de contar | Roda uma vez por eleição; aceitável. Paralelizar as verificações, se preciso     |
| Votos carregados na memória na apuração            | Simplicidade                                                                                                        | Streaming em páginas                                                             |

Para comparação: uma seção eleitoral brasileira tem algumas centenas de eleitores ao longo de 9 horas,
menos de 1 voto por minuto. O gargalo aqui está em outra escala, mas o crescimento O(n²) da linha de
base seria um problema real num serviço centralizado.

## Escala nacional: 156 milhões de eleitores (rodada 3)

**Pergunta:** o sistema aguentaria o Brasil? Rodar 156 milhões (ou 250 milhões) ao pé da letra
num notebook não é viável: seriam centenas de GB de disco e dias de execução. A pergunta útil é
outra: **onde fica o teto, e ele sobe quando se acrescenta hardware?**

A eleição real não é um banco central: são ~470 mil **seções** independentes de algumas centenas de
eleitores. O cenário medido é esse:

```bash
npm run bench:national -- 200 100 64 [processos]   # 200 seções × 100 eleitores, 64 requisições simultâneas
```

O script também amostra o PostgreSQL a cada 100 ms (`pg_stat_activity.wait_event`) para mostrar
**onde** as conexões esperam.

| Versão                                           | Vazão      | Onde as conexões esperavam                       | 156 mi de eleitores levariam |
| ------------------------------------------------ | ---------- | ------------------------------------------------ | ---------------------------- |
| Cadeia de auditoria **global**, 1 processo       | 323/s      | **6,5 de ~8 em `Lock:advisory`** (fila única)    | 134 h                        |
| Cadeia **por eleição**, 1 processo               | ~490/s     | banco quase ocioso: o Node (1 núcleo) é o limite | 88 h                         |
| Cadeia por eleição, **4 processos** da aplicação | ~930–956/s | `LWLock:WALWrite`: o disco do PostgreSQL         | ~45 h                        |
| Cadeia por eleição, 8 processos                  | ~924/s     | idem: teto de **um** PostgreSQL neste notebook   | ~47 h                        |
| 4 processos + group commit (`commit_delay`)      | ~894/s     | sem ganho; configuração revertida                | —                            |

Uma eleição dura 9 h: a média nacional exigida é de **~4.800 eleitores/s**, com picos de 2 a 3 vezes isso.

**O que mudou no código (rodada 3):** uma cadeia de auditoria **por eleição**, com advisory lock
por eleição (migration `audit_chain_per_election`). Antes, todas as habilitações do país passavam
por uma fila única. Detalhes:

- **Logs de auditoria não são reescritos:** o formato é versionado. Os eventos existentes continuam
  na cadeia global (formato 1), verificáveis com o hash original, e eleições antigas continuam nela.
  Eleições novas usam a própria cadeia (formato 2), cujo hash inclui a chave da cadeia.
- **Completude:** como cada eleição tem a própria cadeia, apagar a cadeia **inteira** de uma eleição
  não quebraria nenhum hash. A verificação agora exige que toda eleição tenha o seu `ELECTION_CREATED`
  (`ELECTION_WITHOUT_AUDIT`), exceto as criadas antes de a auditoria existir, marcadas uma única vez
  pela migration. A role da aplicação não pode inserir nem alterar essa marca (testado).
- **Âncoras** (lacre, `verify?electionId=`) passam a se referir à cadeia da eleição. A apuração
  verifica só a cadeia da própria eleição, então fica mais rápida.

**Conclusão:**

1. O gargalo de projeto (a fila global) foi removido. As seções agora são **independentes**: cadeia,
   contadores, locks e verificação são todos por eleição.
2. O limite restante é **físico**: o disco de um único PostgreSQL (cada habilitação e cada voto
   precisam estar gravados antes da confirmação). Desligar essa garantia (`synchronous_commit=off`)
   aumentaria a vazão **perdendo votos confirmados numa queda de energia**: não foi testado de propósito.
3. Como as seções são independentes, o caminho é **particionar**: várias instâncias da aplicação e
   **vários bancos**, cada um com um conjunto de seções (por estado ou zona eleitoral). Neste
   notebook, um banco faz ~950/s (**corrigido depois:** ~1.400/s, ver a rodada 4); 6 a 15 bancos (em hardware de servidor, menos) cobririam a média e
   os picos nacionais. Nenhuma mudança de código é necessária para isso.
4. E o mais importante: a urna brasileira real nem é online. Cada urna apura a própria seção offline,
   e só o **boletim de urna assinado** viaja. A arquitetura deste projeto, agora com tudo por eleição,
   é compatível com esse modelo: cada seção poderia ser uma instância isolada, e o centro só agregaria
   boletins verificáveis (o verificador independente já existe).

## Rodada 4: o mesmo backend em Rust

O backend foi reescrito em Rust (`rust/`), com o mesmo contrato HTTP e o mesmo banco, e comparado
via HTTP real com `npm run bench:compare`. Resultados completos e metodologia em
[`typescript-vs-rust.md`](typescript-vs-rust.md). Em resumo:

| Mesmo cenário (200 seções × 100 eleitores, mesmo total de conexões) |    Vazão |         CPU | Memória de pico |
| ------------------------------------------------------------------- | -------: | ----------: | --------------: |
| TypeScript, 1 processo                                              |   ~500/s |  1,1 núcleo |          347 MB |
| TypeScript, 4 processos                                             |    884/s | 4,2 núcleos |        1.341 MB |
| Rust, 1 processo                                                    | ~1.430/s |  1,1 núcleo |           29 MB |

**Correção da rodada 3.** Lá concluí que um PostgreSQL neste notebook tinha teto de ~950/s, porque
as conexões esperavam em `LWLock:WALWrite`. O Rust atendeu ~1.430/s contra o mesmo banco. Os ~950/s
eram o teto **da pilha TypeScript** contra esse banco, não o teto do disco. Com o Rust, a vazão para
de subir entre 128 e 256 requisições simultâneas, enquanto a latência dobra: ali, sim, o limite é o
PostgreSQL. A estratégia de particionar as seções entre vários bancos continua valendo, mas cada banco
rende ~50% mais do que eu tinha estimado.
