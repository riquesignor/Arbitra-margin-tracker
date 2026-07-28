# Arbitra — scaffold

Spec completa do produto: `ARBITRA_COWORK_PROMPT_COMPLETO.md` (raiz do
projeto). Decisão de arquitetura deste scaffold: `docs/adr/0001-marketplace-adapter-pattern.md`.

## Status

Fundação + tipos + lib core + UI completa (Dashboard/Precificação/Resultados/Conta)
+ Firebase real conectado (Auth por email/senha, Firestore pra `pricing_rules` e
cache de preço `market_prices`). Preço de mercado ainda é mock — SP-API real é o
próximo passo (ver Riscos abaixo). `.env` já populado localmente com credenciais
reais do projeto Firebase; **não commitar**.

### Deploy das Firestore Security Rules + índices

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules,firestore:indexes
```

Sem isso, o Firestore roda com as regras default do console (geralmente
"negar tudo" ou "permitir tudo" dependendo de como o banco foi criado) —
`firestore.rules` neste repo é a fonte da verdade. O índice composto em
`firestore.indexes.json` (`catalog_uploads`: `userId` + `uploadedAt`) é
exigido pela consulta paginada de `listCatalogUploads` — sem o deploy,
o histórico de catálogos quebra em produção com um erro do Firestore
pedindo pra criar o índice (o próprio erro no console do navegador traz
um link que cria automaticamente, se preferir fazer por ali em vez do
CLI).

## Rodar localmente

```bash
npm install
npm run dev
```

Abre `http://localhost:5173`. Upload de um `.csv` ou `.pdf` com produtos —
o pipeline completo (parse → preço → margem) roda. Busca de preço real
(Amazon + Mercado Livre, ver seção abaixo) só funciona via `/api`, que
exige `vercel dev` ou deploy — `npm run dev` puro sempre cai no mock
client-side (ver `priceApi.ts` — campo `source` mostra "servidor" ou
"direto no navegador").

### Seleção de marketplace

Antes do upload, a Dashboard mostra chips pra escolher quais marketplaces
comparar (Mercado Livre e/ou Amazon). Default: os dois marcados — ambos
vêm da mesma fonte real (Google Shopping via SerpApi, ver abaixo) quando
rodando com servidor. A seleção também entra na chave de deduplicação do
histórico (`catalog_uploads`): reenviar o mesmo arquivo com um conjunto
diferente de marketplaces conta como um processamento novo.

### Busca de preço real — Google Shopping via SerpApi

As APIs proprietárias de cada marketplace empacaram: Amazon SP-API só
resolve SKU já cadastrado na sua própria conta de vendedor (não busca
por nome); PA-API exige aprovação como Amazon Associate; Mercado Livre
passou a exigir OAuth com validação de titularidade (fluxo que esbarra
em confirmação de dados via Mercado Pago no DevCenter deles — trabalho
manual, sem garantia de aprovação rápida).

Por isso a busca real hoje (`api/_lib/providers/googleShoppingProvider.ts`)
usa a [SerpApi](https://serpapi.com/) (engine `google_shopping`,
`google_domain=google.com.br`): cadastro só com email — **sem cartão de
crédito** — e free tier de ~250 buscas/mês. Uma única busca por nome de
produto já retorna resultados de várias lojas ao mesmo tempo (Amazon,
Mercado Livre, Magazine Luiza, etc.); o provider filtra pelo campo
`source` do resultado pra saber qual linha corresponde a qual
marketplace selecionado.

Confiança é calculada por similaridade de texto (`textSimilarity.ts`),
não um valor fixo, e o `matchedTitle` retornado aparece no link da
tabela de Resultados pra conferência manual.

**BYOK obrigatório — sem chave compartilhada do servidor.** Cada usuário
cadastra a própria chave SerpApi em Conta; sem login + chave própria, a
busca nem começa (Dashboard mostra um aviso e bloqueia antes de gastar
qualquer chamada). Decisão deliberada: uma chave compartilhada do
servidor (a antiga variável `SERPAPI_KEY`) tem só ~250 buscas/mês
**pra todo mundo junto** — um catálogo médio já consome isso sozinho.
BYOK dá a cada usuário a cota da própria conta, sem depender de um pool
comum. `api/_lib/providers/googleShoppingProvider.ts` não lê mais
`process.env.SERPAPI_KEY` — só aceita a chave que vem no request
(`user_secrets/{uid}`, ver `userSecrets.ts`).

**Limitação de cota ainda existente (por usuário agora, não mais
global)**: se você marcar Amazon + Mercado Livre juntos, o mesmo produto
é buscado 2x na SerpApi (uma chamada por marketplace) — não há
compartilhamento da mesma resposta entre os dois ainda. O cache
Firestore (`market_prices`, TTL 2h, compartilhado entre todos os
usuários) e a dedup do histórico de upload amenizam bastante no
reprocessamento.

#### Setup (uma vez, gratuito, por usuário)

1. Crie uma conta grátis em [serpapi.com](https://serpapi.com/) (só
   email, sem cartão) e pegue sua **API key** no dashboard.
2. Cole ela na tela **Conta** do app, card "Sua chave SerpApi" → Salvar.
3. Pronto — a busca já usa sua chave a partir da próxima tentativa. Não
   precisa mexer em `.env` nem reiniciar nada.

#### Caminho alternativo (parado, não registrado hoje)

O provider Mercado Livre autenticado via OAuth próprio já está
implementado (`api/_lib/providers/mercadoLivreSearchProvider.ts` +
`api/_lib/mlAuth.ts` + `scripts/ml-oauth-setup.mjs`), mas não está
registrado em `api/_lib/providers/registry.ts` — parado por causa da
fricção de validação de titularidade no DevCenter do Mercado Livre. Se
um dia quiser voltar pra essa via (dado mais preciso, direto da fonte,
sem depender de terceiro), os passos estão documentados no histórico do
projeto; é só trocar o registro em `registry.ts`.

### Histórico de catálogos processados

Upload salva automaticamente no Firestore (`catalog_uploads`) se você
estiver logado — nome do arquivo, hash do conteúdo, intervalo de páginas
(se PDF), data e o resultado completo (linhas, preços por marketplace,
margens). Reenviar o mesmo arquivo (mesmo hash + mesmo intervalo de
página) carrega do histórico em vez de reprocessar — tem um link
"Reprocessar mesmo assim" se você quiser preço atualizado. Sem login,
cada sessão reprocessa do zero (não persiste) — e busca de preço nem
roda sem login, já que exige BYOK (ver acima).

**Sobrevive a F5**: `App.tsx` recarrega o registro mais recente de
`catalog_uploads` sempre que o Firebase Auth restaura a sessão (login
normal ou refresh de página) e repopula `catalogRows`/`pricesByMarket`/
`results` com ele — não é um mecanismo novo, só reaproveita o mesmo
histórico. Um catálogo processado nesta aba nunca fica perdido só por
atualizar a página.

### Planos e biblioteca administrável

Base do sistema de planos (Iniciante, Profissional, ...): cada usuário
tem um perfil em `users/{uid}` (`plan` + `isAdmin`, criado automaticamente
no primeiro login via `ensureUserProfile`). Hoje o plano só controla uma
coisa, definida em `src/config/plans.ts`:

- **Biblioteca de catálogos** (`shared_catalogs`): o admin sobe um PDF
  pelo painel Admin, o parser client-side já existente extrai os
  produtos ali mesmo (não guardamos o PDF bruto — só os produtos
  extraídos, de propósito, pra não depender de Firebase Storage/plano
  Blaze), e escolhe quais planos enxergam aquele catálogo. Usuário só
  clica em "usar" — sem re-upload, sem reprocessar o PDF.

Cota de busca **não é mais responsabilidade do plano** — ver seção BYOK
acima: cada usuário busca com a própria chave SerpApi, cadastrada em
Conta, então a cota real é a da conta SerpApi de cada um, não um limite
do app. `usage_daily` (`usageQuota.ts`) continua existindo só como
contador informativo ("N buscas hoje" no Dashboard), sem bloquear nada.

Atribuição de plano é manual (sem billing nesta fase) — pelo painel
Admin (aba só visível pra quem tem `isAdmin: true`) ou direto no
Firestore.

**Bootstrap do primeiro admin**: como o painel Admin exige já ser admin
pra usar, o primeiro precisa ser marcado manualmente. No console do
Firebase → Firestore → coleção `users` → seu documento (ID = seu uid do
Auth) → adicionar campo `isAdmin: true` (boolean). Depois disso, dá pra
promover outros admins direto pelo painel.

Depois de mexer nas regras (`firestore.rules` ganhou entradas novas pra
`shared_catalogs`, `usage_daily` e leitura de `users` por admin), rode
de novo o deploy de regras (seção acima) — sem isso a biblioteca/cota
não vão funcionar em produção.

### Catálogo em PDF

Upload de `.pdf` pede um intervalo de páginas antes de processar (ex:
páginas 5–15). Extração é **heurística por posição de texto**, não um
parser estruturado — ver `src/lib/parsePdfCatalog.ts` pra detalhes e
limitações. Funciona bem pra catálogos com uma linha de texto por produto
(nome + preço). Não funciona em PDF escaneado (imagem sem camada de
texto) — precisaria de OCR, que não está implementado.

## Verificação de tipos e build

```bash
npm run typecheck   # tsc --noEmit (frontend) + tsc --noEmit -p tsconfig.api.json (backend)
npm run build       # typecheck + vite build
```

## Estrutura

```
src/
  types/            # contratos compartilhados (sem acoplamento a marketplace)
  lib/
    marketplaces/    # PriceProvider — adapter pattern (ver ADR-0001)
    parseCatalog.ts
    marginCalculator.ts
    priceApi.ts
  App.tsx            # placeholder de verificação de pipeline, não é a UI final

api/
  fetch-prices.ts    # POST { marketplace, skus } → preços
  _lib/
    cache.ts          # Firestore-backed (market_prices), TTL 2h
    firestoreAdmin.ts # Admin SDK (credenciais via env)
    providers/         # ServerPriceProvider — espelha src/lib/marketplaces

docs/adr/            # decisões de arquitetura
firestore.rules       # regras de segurança (deploy via firebase-tools)
```

## Extensão pra novos marketplaces (Fase 4)

1. Criar `src/lib/marketplaces/shopeeProvider.ts` implementando `PriceProvider`
2. Criar `api/_lib/providers/shopeeProvider.ts` implementando `ServerPriceProvider`
3. Registrar os dois em seus respectivos `registry.ts`
4. Nenhum outro arquivo precisa mudar

## Riscos herdados do master prompt (ainda válidos)

- **SheetJS/xlsx**: não instalar via npm (2 CVEs sem fix). Usar
  `npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` quando
  o parser de Excel for implementado.
- **SP-API não conectado**: descartado por ora (só resolve SKU já
  cadastrado na própria conta, não serve pra achar preço de concorrente).
  Ver `googleShoppingProvider.ts` pra o caminho atual.
- **Firestore security rules**: escritas em `firestore.rules`, mas só têm
  efeito depois de `firebase deploy --only firestore:rules` (ver acima).
- **Parser de PDF é heurístico**: regex sobre texto reconstruído por
  posição, não OCR nem parser de tabela real. Layouts multi-coluna ou
  PDFs escaneados podem não extrair nada ou extrair errado — sempre
  conferir os resultados antes de confiar neles pra decisão de preço.
- **SerpApi é dado de terceiro, sem SLA**: é scraping-as-a-service do
  Google Shopping, não uma API oficial dos marketplaces — pode mudar de
  formato ou ficar instável sem aviso. Cota grátis (~250 buscas/mês) é
  compartilhada entre Amazon e Mercado Livre (uma busca por marketplace
  selecionado, sem cache cruzado ainda — ver nota na seção acima).
#   a m a z o n _  
 