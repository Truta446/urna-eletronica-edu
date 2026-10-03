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
