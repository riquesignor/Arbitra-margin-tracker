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

### Seleção de provider e marketplace

Antes do upload, a Dashboard mostra dois níveis de escolha:

1. **Qual API usar** (`SearchProviderId` — ver `src/types/index.ts` e
   `api/_lib/types.ts`): SerpApi (Google Shopping, cobre Amazon +
   Mercado Livre numa busca só), Amazon direto (RapidAPI) ou Mercado
   Livre direto (API pública) — ver seções abaixo pra cada um. Escolha é
   **por busca, não fixa por conta**: dá pra rodar um catálogo hoje com
   Amazon (RapidAPI) e o mesmo catálogo amanhã com Mercado Livre, sem
   trocar nada além do seletor.
2. **Onde comparar** — só aparece quando o provider é SerpApi (os outros
   dois já cobrem um marketplace fixo cada): chips pra escolher Mercado
   Livre e/ou Amazon dentro da mesma busca.

A seleção completa (provider + marketplaces) entra na chave de
deduplicação do histórico (`catalog_uploads`): reenviar o mesmo arquivo
com uma escolha diferente conta como um processamento novo — inclusive
trocar só o provider, já que o preço pode divergir entre fontes.

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
crédito** — e free tier de 250 buscas/mês **e 50 buscas/hora**
(throughput — os dois limites são independentes, ver
[serpapi.com/pricing](https://serpapi.com/pricing)). Uma única busca por
nome de produto já retorna resultados de várias lojas ao mesmo tempo
(Amazon, Mercado Livre, Magazine Luiza, etc.); o provider filtra pelo
campo `source` do resultado pra saber qual linha corresponde a qual
marketplace selecionado — **uma chamada por produto, não por
produto×marketplace** (ver bloco de busca compartilhada abaixo).

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

**Busca compartilhada entre marketplaces**: marcar Amazon + Mercado
Livre juntos NÃO dobra o consumo — a mesma resposta da SerpApi (que já
traz várias lojas) é repartida entre os dois, uma chamada por produto
independente de quantos marketplaces estão selecionados (ver
`googleShoppingProvider.ts`). O cache Firestore (`market_prices`, TTL
2h, compartilhado entre todos os usuários) e a dedup do histórico de
upload amenizam ainda mais no reprocessamento.

**Cota ainda é por usuário, e o limite de HORA costuma bater antes do de
mês**: um catálogo de 20+ produtos processado de uma vez já soma perto
do teto de 50/hora do plano free, mesmo sobrando cota mensal — a SerpApi
devolve HTTP 429 pros dois casos (mês OU hora esgotados), sem
diferenciar no status. Se aparecer 429, confira o consumo em
[serpapi.com/manage-api-key](https://serpapi.com/manage-api-key) antes
de assumir que é bug.

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

### Busca de preço real — Amazon direto via RapidAPI

Alternativa a SerpApi quando ela estiver sem cota (429) e você só
precisa de Amazon: `api/_lib/providers/rapidApiAmazonProvider.ts` usa a
API [Real-Time Amazon Data](https://rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-amazon-data)
(RapidAPI, by letscrape) — plano free documentado como **100
buscas/mês, sem cartão de crédito**. Mesmo padrão BYOK da SerpApi: cada
usuário cadastra a própria `X-RapidAPI-Key` em Conta (card "Sua chave
RapidAPI"), guardada em `user_secrets/{uid}.rapidApiKey`.

**Setup (uma vez, gratuito, por usuário):**

1. Crie uma conta grátis em [rapidapi.com](https://rapidapi.com/) (só
   email, sem cartão).
2. Assine ("subscribe") a API **Real-Time Amazon Data** no plano
   **Basic** (free) — sem isso a chave funciona pra outras APIs da sua
   conta, mas retorna HTTP 403 nesta especificamente.
3. Copie a `X-RapidAPI-Key` (é a mesma pra qualquer API que você assine
   na RapidAPI) e cole na tela Conta.

Só cobre o marketplace Amazon (não tem Mercado Livre nessa API) — no
Dashboard, escolher esse provider já trava a seleção em "Amazon" sozinho.

> **Nota de manutenção**: os nomes de campo usados no parser
> (`product_title`, `product_price`, etc., ver o provider) seguem a
> documentação pública da API no momento em que foi implementado — como
> qualquer integração de terceiro sem contrato formal, vale conferir
> contra uma resposta real assim que tiver uma chave de teste, e ajustar
> o parser se algum campo tiver mudado de nome.

### Busca de preço real — Mercado Livre direto (endpoint público)

`api/_lib/providers/mercadoLivreDirectProvider.ts` usa o endpoint
público de busca do Mercado Livre (`GET
api.mercadolibre.com/sites/MLB/search?q=...`) — **sem chave, sem
OAuth**, o único caminho realmente grátis pra Mercado Livre hoje.

**Ressalva importante, não escondida da UI**: há múltiplos relatos
recentes (Reclame Aqui, a partir de fev/2026) de HTTP 403 nesse
endpoint especificamente — mesmo com token OAuth válido e outros
endpoints da API do Mercado Livre funcionando normalmente. Não há
comunicação oficial do Mercado Livre explicando o motivo (conta, IP,
allowlist — não documentado publicamente). Por isso o provider **não
cai em mock silencioso** se vier 403: propaga um erro explicando a
situação, em vez de fingir "catálogo sem match". Se acontecer, SerpApi
(com Mercado Livre marcado) continua sendo o caminho estável enquanto
isso não for resolvido pelo lado deles.

### Busca de preço por IMAGEM — Google Lens (SerpApi)

Existe pra catálogos com nome genérico demais ("Faca de corte", sem
marca/modelo/tamanho) — busca por texto acha qualquer coisa parecida, o
match fica ruim. Provider "Busca por imagem (Google Lens)" no Dashboard
usa a foto do PRODUTO (não o nome) como critério: `engine=google_lens`,
`type=products` (SerpApi — mesma chave/cota da busca por texto, é a
mesma conta, só um engine diferente), filtrando por `source` igual à
busca por texto (`api/_lib/providers/googleLensProvider.ts`).

**Só funciona com catálogo .pdf que tenha foto de produto** (CSV nunca
tem imagem pra extrair). Ao processar o PDF com este provider
selecionado, cada linha detectada como produto tem a página renderizada
e uma faixa horizontal recortada como foto de referência
(`src/lib/parsePdfCatalog.ts`, função `cropRowBand`) — heurística por
posição (fronteira = ponto médio entre linhas vizinhas), não recorte
estruturado; se o layout tiver a foto longe do texto correspondente,
pode recortar a coisa errada. Por isso é opcional, não substitui as
outras buscas.

**Hospedagem da foto**: o Google Lens exige uma URL pública de imagem
(não aceita upload direto) — a foto recortada é comprimida (JPEG, até
480px de largura) e salva em `catalog_images/{id}` no Firestore
(`src/lib/catalogImages.ts`), servida por `api/catalog-image.ts`. **Não
usa Firebase Storage de propósito**: desde 3/fev/2026 o Storage saiu do
plano Spark (grátis) — qualquer bucket, mesmo dentro do limite grátis
real do Google Cloud, agora exige plano Blaze com cartão vinculado.
Ficar no Firestore evita isso, ao custo do teto de 1MB por doc (daí a
compressão agressiva) e de **não ter limpeza automática de imagem
expirada ainda** — os docs (TTL de 2h, só verificado na leitura) se
acumulam no Firestore até alguém configurar uma
[TTL policy nativa](https://firebase.google.com/docs/firestore/ttl) no
campo `expiresAt` dessa coleção (console ou `gcloud firestore fields
ttls update`) ou rodar uma limpeza manual — pendente, aceitável na fase
de teste, não em produção com volume real.

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
  formato ou ficar instável sem aviso. Cota grátis é 250 buscas/mês e
  50/hora (throughput) — ver nota na seção acima sobre qual dos dois
  costuma bater primeiro e como diagnosticar um HTTP 429.
- **RapidAPI (Amazon direto) também é terceiro, sem SLA e sem contrato
  formal com este projeto**: cota free é mais apertada (100/mês) que a
  da SerpApi. Nomes de campo da resposta seguem a documentação pública
  no momento da implementação — vale reconferir com uma chave real.
- **Mercado Livre direto (endpoint público) está instável desde
  fev/2026** (HTTP 403 não documentado, ver seção acima) — é o único
  caminho grátis-sem-chave pra Mercado Livre, mas não é garantido; trate
  como "vale tentar", não como fonte estável de produção.
- **Busca por imagem (Google Lens) tem recorte heurístico e imagens sem
  limpeza automática**: o crop por linha (`cropRowBand`) pode capturar a
  foto errada em layouts de catálogo incomuns, e os documentos de foto
  temporária em `catalog_images` (Firestore) não são apagados sozinhos
  ainda — configurar TTL policy nativa antes de usar com volume real
  (ver seção acima).
#   a m a z o n _  
 