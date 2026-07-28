# ADR-0001: Adapter Pattern para Price Providers (client e server)

**Status:** Accepted
**Date:** 2026-07-20
**Deciders:** Nicolas (produto/arquitetura)

## Context

O master prompt do Arbitra (`ARBITRA_COWORK_PROMPT_COMPLETO.md`) especifica a
Fase 2 como Amazon-only: `mockAmazonApi.ts`, `AmazonPriceResult`,
`/api/fetch-amazon-prices`, `spApiPricing.ts` — tudo nomeado e tipado em
função de um único marketplace. O roadmap do próprio doc, porém, já prevê
Shopee e Mercado Livre na Fase 4 ("Longo prazo").

Este scaffold está sendo construído do zero (a pasta do projeto estava
vazia — não havia código da Fase 2 pra herdar). Isso abre a oportunidade de
decidir a arquitetura de dados de preço pensando desde já em múltiplos
marketplaces, em vez de nomear tudo como "Amazon" e ter que refatorar
type-by-type quando Shopee/ML entrarem.

**Restrição:** os passos atuais (fundação, tipos, lib core, backend) não
têm credenciais reais (Firebase/SP-API) — rodam 100% em mock. A decisão de
arquitetura precisa isolar esse fato, pra trocar mock por API real sem
reescrever consumidores.

## Decision

Introduzir uma interface `PriceProvider` (client, em `src/lib/marketplaces/`)
e sua espelha `ServerPriceProvider` (server, em `api/_lib/providers/`).
Qualquer marketplace — mock ou real — implementa essa interface e se
registra uma vez em um `registry.ts`. Nenhum outro módulo (`marginCalculator`,
`parseCatalog`, o endpoint `/api/fetch-prices`, futuros componentes de UI)
conhece o marketplace concreto: eles recebem `MarketplaceId` como parâmetro
e usam o registry pra resolver o provider.

O endpoint HTTP foi generalizado de `/api/fetch-amazon-prices` (Fase 2 do
master prompt) para `/api/fetch-prices` com `{ marketplace, skus }` no body
— mesmo contrato de resposta, um parâmetro a mais.

## Options Considered

### Option A: Adapter/Strategy pattern com registry (escolhida)

| Dimensão | Avaliação |
|---|---|
| Complexidade | Baixa–Média (uma interface + um Map de registro) |
| Custo de adicionar marketplace | 1 arquivo novo + 1 linha de registro |
| Familiaridade do time | Alta (Strategy é padrão comum em TS/React) |
| Risco de over-engineering | Baixo — abstração fina, sem DI framework |

**Pros:** Shopee/ML entram sem tocar em `marginCalculator`, `parseCatalog`,
endpoint ou UI. Mock e real implementam a mesma interface, então trocar um
pelo outro é local ao registry. Testável (mock injetável).
**Cons:** Mais um nível de indireção que "só usar a função direto" — exige
disciplina pra não vazar detalhes de um marketplace específico (ex: campos
só-Amazon) pro tipo genérico `MarketplacePriceResult`.

### Option B: Hardcoded Amazon-only (replicar o master prompt ao pé da letra)

| Dimensão | Avaliação |
|---|---|
| Complexidade | Baixíssima agora |
| Custo de adicionar marketplace | Alto — reescrever tipos, endpoint, calculator quando Shopee/ML chegarem |
| Familiaridade do time | Alta |
| Risco de over-engineering | Nenhum agora, mas gera retrabalho depois |

**Pros:** Mais simples de escrever hoje, é literalmente o que o master
prompt documenta.
**Cons:** Contradiz a instrução explícita de "pensar em como vai ser mexido
pra adicionar as outras funções" — Fase 4 exigiria renomear
`AmazonPriceResult`→genérico, reescrever o endpoint e migrar consumidores.

### Option C: Plugin system dinâmico (carregar providers via config/DI container)

| Dimensão | Avaliação |
|---|---|
| Complexidade | Alta |
| Custo de adicionar marketplace | Baixo, mas com overhead de configuração |
| Familiaridade do time | Baixa/Média — exige DI framework ou loader customizado |
| Risco de over-engineering | Alto pra 1 marketplace ativo hoje |

**Pros:** Máxima flexibilidade (registro em runtime, feature flags por
marketplace).
**Cons:** Complexidade não justificada com um único marketplace ativo e
nenhuma credencial real ainda configurada. YAGNI.

## Trade-off Analysis

A decisão central é **quanto de abstração comprar agora vs. depois**.
Option B otimiza pra velocidade imediata mas paga juros altos na Fase 4
(retrabalho documentado no próprio master prompt). Option C compra
flexibilidade que ninguém pediu ainda — nenhum requisito atual precisa de
registro dinâmico em runtime. Option A é o meio-termo: o custo de escrever
uma interface + registry estático é baixo, pago uma vez, e o benefício
(extensão por arquivo novo, zero refactor) se realiza exatamente quando o
roadmap diz que vai precisar (Fase 4).

Segunda decisão embutida: **tipos duplicados entre `src/types` e
`api/_lib/types`** em vez de um pacote compartilhado. Escolhido porque (a)
frontend e backend já têm tsconfigs incompatíveis (DOM vs Node) no master
prompt original, (b) um workspace/monorepo formal é complexidade que não se
paga ainda com 2 pacotes. Se a duplicação começar a causar bugs de shape
divergente, extrair pra `packages/shared` é o próximo passo natural.

## Consequences

- **Fica mais fácil:** adicionar Shopee/Mercado Livre (Fase 4) — 1 arquivo
  de provider + 1 linha de registro, dos dois lados (client/server).
- **Fica mais fácil:** testar `marginCalculator` e `parseCatalog` isolados,
  já que não dependem de nenhum detalhe de marketplace concreto.
- **Fica mais difícil:** debugar "qual provider está respondendo" sem um
  log explícito — o registry esconde a resolução. Mitigação: o campo
  `source: "live" | "mock"` já retorna pra UI, e cada provider carrega seu
  `id`.
- **Precisa revisitar:** o cache in-memory (`api/_lib/cache.ts`) não
  sobrevive a cold start de Edge Function nem é compartilhado entre
  instâncias — é um placeholder explícito até Firestore entrar (Fase 2 do
  master prompt), mantendo a mesma assinatura de função.
- **Precisa revisitar:** parsing de `.xlsx` foi propositalmente deixado de
  fora deste scaffold — o master prompt já documenta 2 CVEs no pacote
  `xlsx` do npm (prototype pollution + ReDoS) sem fix publicado. Quando
  Excel entrar, instalar via CDN da SheetJS (`cdn.sheetjs.com`), nunca via
  `npm install xlsx`.

## Action Items

1. [x] Definir `PriceProvider` / `ServerPriceProvider` e registries (client + server)
2. [x] Generalizar tipos (`MarketplacePriceResult` em vez de `AmazonPriceResult`)
3. [x] Generalizar endpoint (`/api/fetch-prices` parametrizado por `marketplace`)
4. [ ] Rodar `npm install` + `typecheck` + `build` neste scaffold e corrigir eventuais erros antes de copiar pra pasta final
5. [ ] Quando credenciais Firebase/SP-API estiverem disponíveis: implementar `createAmazonSpApiProvider()` (server) mantendo a interface, sem tocar em `fetch-prices.ts`
6. [ ] Quando cache precisar sobreviver a cold start: implementar Firestore-backed cache com a mesma assinatura de `getCachedPrices`/`writeCachedPrices`
7. [ ] Quando Excel entrar: instalar SheetJS via CDN (não npm) e adicionar o branch `.xlsx` em `parseCatalog.ts`
8. [ ] Fase 4: implementar `createShopeeProvider()` / `createMercadoLivreProvider()` (client + server) e registrar
