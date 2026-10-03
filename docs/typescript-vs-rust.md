# TypeScript × Rust

O backend existe em duas implementações no mesmo repositório:

|              | TypeScript (`src/`)                                                  | Rust (`rust/`)                                                            |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| HTTP         | Fastify                                                              | axum 0.8 + tokio                                                          |
| Banco        | Prisma + `@prisma/adapter-pg`                                        | sqlx 0.9 (SQL escrito à mão)                                              |
| Validação    | Zod                                                                  | serde (`deny_unknown_fields`) + validação explícita                       |
| Criptografia | `node:crypto`, `@hpke/core`, `canonicalize`, `shamir-secret-sharing` | RustCrypto (`sha2`, `hmac`, `hkdf`), `ed25519-dalek`, `hpke`, `serde_jcs` |
| Porta padrão | 3000                                                                 | 3010 (`RUST_PORT`)                                                        |

As duas usam **o mesmo PostgreSQL, as mesmas migrations, a mesma role de menor privilégio
(`urna_app`) e o mesmo `.env`**. Todas as invariantes que dependem do banco (triggers, CHECKs,
contadores, chaves estrangeiras) valem igualmente para as duas, porque estão no banco. As duas
podem rodar **ao mesmo tempo contra o mesmo banco**: uma eleição criada por uma pode receber votos
pela outra e ser apurada por qualquer uma delas.

```bash
npm run rust:build && npm run rust:start      # http://127.0.0.1:3010
API_TARGET=http://127.0.0.1:3010 npm run web  # o front de estudo usando o backend em Rust
```

## Como sabemos que as duas fazem a mesma coisa

Reescrever um sistema assim tem um risco óbvio: a versão nova "funcionar", mas aceitar algo que a
antiga recusava. Por isso a equivalência foi verificada em quatro camadas:

1. **Criptografia byte a byte** (`rust/tests/crypto_compat.rs`, 9 testes). O script
   `npm run rust:fixtures` gera, **com o código TypeScript**, vetores de teste: hash de token,
   nullifier, commitments v1 e v2, HMAC do eleitor, raiz Merkle, JCS, assinatura Ed25519, partes
   Shamir e um voto cifrado com HPKE. O Rust precisa reproduzir os mesmos bytes (a assinatura Ed25519
   é determinística, então precisa sair **idêntica**) e decifrar o voto cifrado pelo TypeScript.
2. **Suíte de contrato HTTP** (`npm run test:contract`, `test/contract/`). Os mesmos 17 testes rodam
   contra os dois servidores: status, códigos de erro, headers de segurança, autenticação antes do
   corpo, 400/413/415, regras de agenda, corridas (20 envios simultâneos com o mesmo token geram
   exatamente 1 voto), idempotência, arredondamento da expiração, apuração, publicação e auditoria
   sem dados do eleitor. A suíte foi testada contra si mesma: removendo de propósito o
   arredondamento ao minuto do Rust, ela falha (e volta a passar com o código restaurado).
3. **O e2e do navegador** (Playwright: eleição **cifrada**, partes dos trustees, urna, apuração e
   o verificador WebCrypto no browser) passa contra o Rust:
   `API_TARGET=http://127.0.0.1:3010 npm run web:e2e`.
4. **Verificação independente**: o verificador TypeScript (`npm run verify:result`) confere o
   resultado publicado pelo Rust (hash, assinatura, lacre, Merkle e commitments).

## O benchmark

```bash
npm run bench:compare -- <seções> <eleitores por seção> <simultâneas> <conexões> [processos TS]
```

Para cada backend: zera o banco `urna_bench`, sobe o servidor (TS **compilado**, `node dist/server.js`;
Rust em `--release`), prepara as seções fora da medição, **aquece** (JIT do V8, pools, cache do
PostgreSQL) e então mede via **HTTP real** (não `inject()`):

- **latência sem concorrência**: um eleitor por vez, mostra o custo de cada requisição;
- **carga "nacional"**: muitas seções votando ao mesmo tempo (habilitação + voto por eleitor).

A carga sai de processos geradores separados, para o gerador não disputar CPU com o servidor medido
(o script mostra a CPU dos geradores). O total de conexões com o banco é o mesmo para as duas: com
N processos TS, cada um recebe 1/N das conexões. No fim, o script confere no banco que **todos** os
votos foram gravados, e qualquer erro aborta a medição.

### Resultados

Máquina: notebook com 24 núcleos e 30 GB de RAM. Servidor, PostgreSQL 18 (Docker) e geradores rodam
na mesma máquina. Cenário: 200 seções × 100 eleitores = 20 mil eleitores por rodada.

**1 processo × 1 processo** (64 simultâneas, 20 conexões):

|                                       |         TypeScript |               Rust |      |
| ------------------------------------- | -----------------: | -----------------: | ---: |
| Vazão (eleitores/s)                   |                499 |              1.082 | 2,2× |
| Habilitação p50 / p95 / p99 (ms)      | 63,7 / 77,8 / 85,8 | 26,1 / 49,8 / 61,1 |      |
| Voto p50 / p95 / p99 (ms)             | 63,3 / 76,7 / 86,4 | 25,4 / 47,6 / 58,9 |      |
| Habilitação p50 sem concorrência (ms) |                7,1 |                4,2 | 1,7× |
| Voto p50 sem concorrência (ms)        |                6,9 |                3,7 | 1,9× |
| CPU do servidor (% de 1 núcleo)       |                110 |                 77 |      |
| CPU por eleitor (ms)                  |               2,20 |               0,71 | 3,1× |
| Memória ociosa (MB)                   |                140 |                  7 |  21× |
| Memória de pico (MB)                  |                347 |                 19 |  18× |
| Tempo até ficar pronto (ms)           |                235 |                 22 |  11× |

**Escalando** (sempre o mesmo total de conexões com o banco para as duas):

| Configuração                                     | TypeScript                  | Rust (1 processo)          |
| ------------------------------------------------ | --------------------------- | -------------------------- |
| 128 simultâneas, 40 conexões, **1** processo TS  | 497/s · 110% CPU · 362 MB   | 1.428/s · 110% CPU · 28 MB |
| 128 simultâneas, 40 conexões, **4** processos TS | 884/s · 418% CPU · 1.341 MB | 1.439/s · 111% CPU · 29 MB |
| 256 simultâneas, 80 conexões, **8** processos TS | 823/s · 583% CPU · 2.646 MB | 1.388/s · 112% CPU · 50 MB |

**Implantação e código:**

|                          | TypeScript                                                                                                                              | Rust              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| O que se implanta        | ~491 MB: `node` (117) + `node_modules` de produção (374, a maior parte é o Prisma, incluindo o CLI usado nas migrations) + código (0,5) | binário de 5,1 MB |
| Dependências de produção | 205 pacotes npm                                                                                                                         | 191 crates        |
| Linhas do backend        | ~3.500                                                                                                                                  | ~3.150            |

### O que os números dizem

1. **Um processo Node trava em um núcleo.** Com 64 ou 128 requisições simultâneas a vazão do TS fica
   em ~500/s e só a latência cresce: a thread principal está em 100% (110% contando as threads do
   GC e do libuv). Com o PostgreSQL folgado, o limite é a CPU do próprio Node.
2. **O Rust gasta ~3× menos CPU por eleitor** (0,7 ms contra 2,2 ms) e usa vários núcleos num só
   processo (o tokio distribui as requisições entre threads). A diferença de CPU **não foi perfilada
   em detalhe**. Os suspeitos principais são a camada do Prisma (cada query passa pelo compilador de
   queries e pelo adapter), a validação e a serialização. O SQL executado é praticamente o mesmo.
3. **Mais processos Node ajudam, até certo ponto.** Com 4 processos o TS chega a 884/s, usando 4,2
   núcleos e 1,3 GB. Com 8 processos, **piora** (823/s): mais processos disputando o mesmo banco, e
   cada um com seu pool, seu heap e seu JIT.
4. **O Rust para em ~1.400/s, e aí o limite é o PostgreSQL.** De 128 para 256 requisições simultâneas
   a vazão não sobe (1.439 → 1.388/s), a latência dobra e a CPU do servidor fica em ~110%. Ou seja,
   o processo Rust está **esperando o banco**, não calculando.
5. **Memória: de 20 a 50 vezes menos.** Um processo Rust ocioso ocupa 7 MB. Um processo Node
   ocioso, 140 MB, e o pico sob carga multiplica isso pelo número de processos.

### Uma correção no que foi escrito antes

O [`performance.md`](performance.md) (rodada 3) concluiu que "um PostgreSQL neste notebook faz
~950/s" porque, com 4 a 8 processos TS, as conexões esperavam em `LWLock:WALWrite`. O benchmark com
o Rust mostra que **essa conclusão estava errada no número**: o mesmo banco, na mesma máquina,
atendeu ~1.430/s. Os ~950/s eram o teto **da pilha TS** contra esse banco (mais tempo de CPU por
transação e mais processos competindo), não o teto do disco. A conclusão de arquitetura continua
valendo: a partir de algum ponto o limite é um único PostgreSQL, e o caminho é particionar as seções
entre vários bancos. Só que esse ponto está ~50% mais alto do que eu tinha estimado.

Para 156 milhões de eleitores em 9 horas (média de ~4.800/s), seriam ~4 bancos com o backend em
Rust contra ~6 com o TS, sem contar os picos. **Isso não muda a conclusão principal:** uma eleição
nacional não deveria depender de um serviço online (veja a seção de escala nacional em
[`performance.md`](performance.md)).

### Cuidados ao ler os números

- Servidor, banco e geradores dividem a mesma máquina. Num ambiente com máquinas separadas, os
  números absolutos mudam. A comparação é justa porque as duas versões rodam nas mesmas condições.
- Rodadas repetidas variam alguns por cento. Diferenças menores que ~10% não devem ser lidas como
  significativas.
- O TS foi medido no modo de implantação (compilado, `node dist/server.js`, sem `tsx`) e aquecido antes da
  medição, então o JIT do V8 já estava otimizado.
- "Linhas do backend" conta comentários. As duas versões são comentadas no mesmo estilo.

## E a segurança?

Rust elimina uma **classe** de defeitos: erros de memória (buffer overflow, use-after-free, data race
em memória compartilhada). O crate é marcado com `#![forbid(unsafe_code)]`: o compilador recusa
qualquer `unsafe` no código do projeto. Isso é uma **propriedade garantida** para o nosso código. As
dependências têm `unsafe` internamente (como qualquer runtime, inclusive o próprio Node), então não
vale para elas.

O que **não muda** com a troca de linguagem:

| Propriedade                                                         | Classificação                               | Por quê                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Segurança de memória do código do projeto                           | **Garantida** (Rust, `forbid(unsafe_code)`) | No TS também não há acesso direto à memória. A diferença real fica no runtime (V8/Node em C++) e nas dependências             |
| Invariantes do banco (um voto por eleitor, imutabilidade, balanços) | **Garantida pelo banco**, igual nas duas    | Estão em triggers e constraints, não na linguagem                                                                             |
| Voto secreto contra quem controla o servidor                        | **Não garantida**, igual nas duas           | Quem controla o processo vê a escolha no momento do voto (ver `threat-model.md`)                                              |
| Cadeia de suprimentos                                               | **Risco conhecido**, de tamanho parecido    | 191 crates contra 205 pacotes npm. Recomenda-se `cargo audit`/`cargo vet` e `npm audit` (não fazem parte do CI deste projeto) |
| Reconstrução da chave (Shamir)                                      | **Parcialmente mitigada**                   | Veja abaixo                                                                                                                   |

**Sobre o Shamir no Rust.** Não existe crate compatível com o formato da biblioteca usada no
TypeScript (o formato do HashiCorp Vault). Então o `combine` (só a reconstrução, não a divisão) foi
**portado** dessa biblioteca, com as mesmas tabelas de logaritmo e exponencial em GF(2⁸), e testado
contra partes geradas pelo TS. Isso contraria o espírito de "não implemente criptografia
caseira", e por isso fica registrado: é uma porta fiel de código auditado (~90 linhas, boa parte delas as duas tabelas), e roda uma
única vez por eleição, na apuração. A versão portada consulta tabelas com índices que dependem do
segredo, então **não é de tempo constante**. A original em JavaScript também não promete isso: o README dela diz que tempo constante real é irrealista numa linguagem com JIT e GC. Um atacante capaz de medir o tempo dessa única operação
dentro do servidor de apuração poderia, em tese, aprender algo sobre a chave. Classificação: **risco
conhecido**, aceito por ser um projeto educacional. Numa versão real, a reconstrução deveria
acontecer num equipamento isolado ou num HSM, nunca no servidor web.

**Nada disso torna qualquer uma das versões adequada para uma eleição real.** A linguagem é uma
peça pequena da segurança de um sistema eleitoral, como discutido no guia (hardware dedicado,
votação offline, builds reprodutíveis, auditoria pública do código e procedimentos físicos).

## Mapa do código Rust

| Arquivo                  | Equivalente TS                 | Conteúdo                                                                                                                |
| ------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `src/main.rs`            | `src/server.ts`                | `.env`, pool, servidor, encerramento gracioso (SIGINT/SIGTERM)                                                          |
| `src/lib.rs`             | `src/app.ts`                   | Rotas e camadas (rate limit, log, headers, timeout de 15 s)                                                             |
| `src/config.rs`          | `src/config/env.ts`            | Mesmas variáveis e mesmas regras de produção                                                                            |
| `src/error.rs`           | `src/shared/errors/`           | Mesmo formato `{ error: { code, message, issues? } }`. Erros do banco viram respostas sem vazar detalhes                |
| `src/http/auth.rs`       | `shared/http/operator-auth.ts` | Extractors de cabeçalho: rodam **antes** de o corpo ser lido. Comparação em tempo constante contra todas as credenciais |
| `src/http/extract.rs`    | `shared/validation`            | JSON estrito, limite de 16 KiB, 400/413/415, UUID nos parâmetros                                                        |
| `src/audit.rs`           | `modules/audit`                | Cadeia de hashes (formatos 1 e 2), advisory lock por cadeia, verificação                                                |
| `src/routes/*.rs`        | `modules/*`                    | Eleições, candidatos, eleitores, habilitação, voto, apuração e publicação                                               |
| `src/crypto/*.rs`        | `src/security/*`               | Tokens, commitments, HMAC, Merkle, Ed25519, HPKE, Shamir (`combine`)                                                    |
| `tests/crypto_compat.rs` | —                              | Compatibilidade byte a byte com o TS                                                                                    |

O SQL é sempre uma **string fixa em tempo de compilação**: o sqlx 0.9 recusa SQL montado em tempo de
execução (`format!`), uma barreira contra SQL injection. As listas de colunas reutilizadas são macros
(`concat!`), não strings dinâmicas.
