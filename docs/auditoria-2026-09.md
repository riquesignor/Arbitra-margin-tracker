# Auditoria completa — Arbitra (set/2026)

> **Status da execução (atualizado na mesma data):** **os 24 itens estão
> implementados e validados** — todos os P0 (1-4), todos os P1 (5-8), toda a
> parte de precisão de busca (9-14), leitura de catálogo (15-18) e experiência
> (19-24).
>
> **Atualização (mesma data, 2ª rodada): os 24 itens estão fechados.** Entraram
> 18 (2ª passada de OCR na faixa do preço, `ocrPriceFromBand` em
> parsePdfCatalog.ts — worker próprio com whitelist de caracteres e PSM de
> linha única, roda antes da correção via Gemini e não exige chave), 21 (razão
> por SKU: `api/_lib/searchMissReasons.ts` → `_reasons` na resposta → resumo
> agrupado na tela; derivada no ponto de saída, sem mexer nos 6 providers), 23
> (barra de cota deixou de ser exclusiva do SerpApi, passa a usar o teto
> autoritativo do servidor e mostra o custo REAL da última busca) e 24
> (`src/config/providerKeys.ts`: aviso com link pra criar a chave e o custo,
> exibido ao ESCOLHER o mecanismo, não depois da busca falhar).
>
> **Também nesta rodada (fora da auditoria original), contra o bloqueio das
> lojas e pra conferência manual:**
>
> - **Download de imagem instrumentado e com proxy** (`safeImageUrl.ts`): host +
>   status HTTP no log do servidor, e 2ª tentativa via ScraperAPI quando a loja
>   responde 401/403/405/429/503. Era o vetor invisível — thumbnail bloqueada
>   fazia o candidato perder a comparação visual e o sintoma chegava como "a IA
>   não confirmou nada". 404/410 não repetem (não queima crédito à toa) e foto
>   do próprio app nunca vai pro proxy.
> - **Fonte de candidatos com rede de segurança** (`fetchCandidateOffers` em
>   visionInternalSearchProvider.ts): a raspagem continua primária; quando a
>   Amazon volta vazia ou bloqueada, cai pro endpoint estruturado
>   (`fetchAmazonCandidatesForQuery`, 5 créditos/consulta). Mercado Livre segue
>   só na raspagem de propósito — a alternativa via Google Shopping custaria o
>   link do anúncio e o nº de vendas.
> - **Popularidade do anúncio na tela**: `reviewCount`/`rating` já eram
>   extraídos e já pesavam no desempate, mas morriam no servidor. Agora viajam
>   até a UI (badge com 🔥 vendas no ML / ⭐ avaliações na Amazon) e o CSV.
> - **Zoom na miniatura** (`ProductThumb`): clicar amplia a foto do anúncio —
>   a mesma imagem que a IA usou pra decidir. É a verificação manual que sobra
>   quando a fonte não devolve link.
>
> `tsc` client+api limpos e **271 testes passando** (17 novos nesta rodada).
>
> **Em aberto, pendente de evidência real:** a API pública do Mercado Livre
> (`api.mercadolibre.com/sites/MLB/search`) como substituta da raspagem do ML —
> o teste feito daqui foi inconclusivo (resposta vazia), precisa de uma chamada
> a partir do servidor, com log de status, antes de virar plano.
>
> ⚠️ **Ação manual pendente:** `firestore.rules` não sobe no deploy da Vercel —
> precisa de `firebase deploy --only firestore:rules`. Sem isso, os itens P0-1
> (escalonamento de privilégio), P0-3 (contador de cota protegido) e P1-6
> (índice da foto) continuam abertos em produção.
>
> ⚠️ **Recomendado no console do Firebase:** ativar TTL policy no campo
> `expiresAt` das coleções `catalog_images` e `catalog_image_index` — sem isso,
> os documentos expirados continuam ocupando espaço (não há limpeza automática).

Levantamento feito lendo o código real (`src/`, `api/`, `firestore.rules`, `vercel.json`),
não por amostragem. Cada item tem arquivo/linha, o impacto concreto e a correção proposta.

**Placar:** 4 achados P0 (2 deles exploráveis por qualquer usuário logado), 4 P1,
6 de precisão de busca, 4 de leitura de catálogo, 6 de experiência.

---

## P0 — Corrigir antes de qualquer outra coisa

### 1. Escalonamento de privilégio: qualquer usuário vira admin sozinho
**Onde:** `firestore.rules:29-31`

```
match /users/{userId} {
  allow read, write: if isOwner(userId);   // <- write IRRESTRITO no próprio doc
  allow read, update: if isAdmin();
```

O dono pode escrever **qualquer campo** do próprio perfil, inclusive `isAdmin: true` e
`plan: "pro"`. E são exatamente esses campos que sustentam:

- `isAdmin()` na própria rule (`firestore.rules:10-13`) → leitura/edição do perfil de **todos** os usuários;
- `requireAdmin()` no servidor (`api/_lib/adminAuth.ts:18-22`) → libera `/api/admin-diagnostics`;
- leitura de `shared_catalogs` por plano (`firestore.rules:124-127`) → biblioteca inteira, sem pagar.

Não precisa de exploit nenhum: um `setDoc(doc(db,'users',meuUid),{isAdmin:true},{merge:true})`
no console do navegador basta.

**Correção:** restringir os campos graváveis pelo dono na rule.

```
allow update: if isOwner(userId)
  && request.resource.data.diff(resource.data).affectedKeys()
       .hasOnly(['displayName','photoURL','hasSerpApiKey','hasRapidApiKey',
                 'hasSearchApiKey','hasUnwrangleApiKey','hasGeminiApiKey','hasMistralApiKey']);
allow update: if isAdmin();   // só admin (ou o Admin SDK) mexe em isAdmin/plan
```

As flags `has*ApiKey` continuam graváveis porque `userSecrets.ts` as escreve no mesmo batch.
Se preferir fechar mais ainda, mover essas flags pro Admin SDK e deixar o perfil read-only pro dono.

**Esforço:** ~30 min (rule + teste manual com 2 contas).

---

### 2. SSRF: o servidor baixa qualquer URL que o cliente mandar
**Onde:** `api/_lib/geminiVision.ts:109-131` e `api/_lib/mistralVision.ts:109`

```ts
const response = await fetch(imageUrl, { signal: controller.signal }); // imageUrl vem do body
```

`item.imageUrl` chega direto do corpo da requisição e **não é validado em lugar nenhum** —
`isValidItems` (`api/fetch-prices.ts:73-79`) só checa `sku` e `name`. Um usuário logado
consegue fazer a função serverless buscar `http://169.254.169.254/...`, `http://localhost:...`
ou qualquer host interno, e a mensagem de erro devolve o status HTTP
(`Não consegui baixar a imagem (${imageUrl}): HTTP ${response.status}`) — oráculo de varredura.
Também não há teto de bytes: `arrayBuffer()` aceita um download de qualquer tamanho.

**Correção:** allowlist de origem + guarda de rede.

1. Aceitar só URL do próprio app apontando pra `/api/catalog-image` (é o único formato que
   `uploadCatalogImage` gera — `src/lib/catalogImages.ts:183`);
2. rejeitar esquema fora de `https:` (e `http:` só em dev), IPs privados/loopback/link-local;
3. `redirect: "error"` e teto de bytes (ex.: 8 MB) lendo o stream, não `arrayBuffer()` cego;
4. na mensagem de erro, não ecoar a URL nem o status recebido.

**Esforço:** ~1h30 (função `assertSafeImageUrl` pura + testes).

---

### 3. `/api/fetch-prices` sem teto de lote nem cota no servidor
**Onde:** `api/fetch-prices.ts:114-158`; cota em `src/lib/usageQuota.ts` (só cliente)

- `items` não tem limite de tamanho — dá pra mandar 5.000 produtos numa chamada.
- Não existe rate limit nenhum por uid.
- A cota diária (`config/plans.ts:16`) é **informativa e client-side**: quem incrementa é o
  próprio navegador (`Dashboard.tsx:1149`), e a rule permite o usuário escrever o próprio
  contador (`firestore.rules:86-88`) — ou seja, zerável à vontade.
- O provider default é `scraperapi`, que usa `SCRAPERAPI_KEY` — **secret do dono da
  plataforma**, não BYOK. Ou seja: crédito seu, gasto sem teto por qualquer conta criada.

**Correção:**

1. `if (items.length > MAX_ITEMS_PER_REQUEST) return 400` (o cliente já fatia em 20 —
   `Dashboard.tsx:372` —, então 50 é folgado);
2. contador diário **server-side** em `users/{uid}/usage_daily/{yyyymmdd}` via Admin SDK
   dentro de uma transaction, retornando `429` com mensagem clara ao estourar;
3. separar o teto por provider: quem usa BYOK gasta a própria cota (teto alto), quem usa
   `scraperapi` gasta a sua (teto baixo);
4. `market_prices` já protege contra repetição de busca — manter.

**Esforço:** ~3h.

---

### 4. Chaves BYOK trafegando pelo navegador
**Onde:** `src/lib/userSecrets.ts` (lê texto puro no client) → `src/lib/priceApi.ts:100`
(`body: JSON.stringify({ ..., apiKey })`) → `api/fetch-prices.ts:187,277,289,297`

Hoje o navegador lê a chave em texto puro do Firestore e a reenvia no corpo de cada
requisição. Consequência: **qualquer XSS no app exfiltra todas as chaves de API do usuário**
(SerpApi, RapidAPI, SearchApi, Unwrangle, Gemini, Mistral) — e não há CSP pra conter (item 5).
Não há motivo técnico pra isso: o servidor já sabe o `uid` (token verificado em
`verifyAuth.ts:31`) e tem Admin SDK.

**Correção:** o servidor lê `users/{uid}/secrets/keys` com o Admin SDK e escolhe o campo
conforme o `provider` da requisição; o cliente para de ler e de enviar `apiKey`. O campo
`apiKey` do body vira ignorado (aceito por compatibilidade por uma versão, depois removido).
Bônus: some a classe de bug "usuário salvou a chave mas a busca foi sem ela".

**Esforço:** ~2h (uma função `getUserApiKeyForProvider(uid, provider)` no servidor + limpeza no cliente).

---

## P1 — Segurança e higiene

### 5. Nenhum header de segurança
**Onde:** `vercel.json` (só `maxDuration`)

Sem `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options`/`frame-ancestors`, `Permissions-Policy`, `Strict-Transport-Security`.
Com as chaves BYOK vivendo no cliente (item 4), CSP é o que separa "um XSS" de
"todas as chaves de todos os usuários vazadas".

**Correção:** bloco `headers` no `vercel.json`, CSP começando em `report-only` por alguns dias
(o app carrega pdf.js/tesseract via bundle e faz `connect-src` pro Firebase e pro próprio `/api`).

**Esforço:** ~1h + ajuste fino do CSP.

---

### 6. `/api/catalog-image`: público, com UID na URL, sem limite e sem faxina
**Onde:** `api/catalog-image.ts:21-56`; geração da URL em `src/lib/catalogImages.ts:183`

Ser público é uma decisão correta (o crawler do Google Lens não manda header de auth), mas:

- a URL carrega o **UID do usuário em texto** e é entregue a terceiros (SerpApi, SearchApi.io);
- não há rate limit — um mesmo `uid+id` pode ser puxado infinitas vezes;
- o TTL só é checado na leitura: os docs expirados **nunca são apagados**
  (já documentado em `catalogImages.ts:31-37`) — Firestore acumulando base64 pra sempre.

**Correção:** trocar `?uid=&id=` por um token opaco assinado (HMAC com `expiresAt` embutido,
segredo em env) — some o UID e a validade passa a ser verificável sem tocar no banco;
ativar TTL policy nativa do Firestore no campo `expiresAt`; cache-control já está ok.

**Esforço:** ~2h + 5 min de console pro TTL.

---

### 7. `href` externo sem validação de esquema
**Onde:** `src/components/ResultsTable.tsx:597,690,774,823`; `src/components/Portfolio.tsx:199`

`r.link` vem da resposta de API de terceiro e vai direto pro `href`. `rel="noopener noreferrer"`
está correto em todos, mas um `javascript:` (ou `data:`) vindo de upstream comprometido
executaria no clique.

**Correção:** helper `safeHttpUrl(url)` que só devolve a URL se `new URL(url).protocol`
for `http:`/`https:`, senão `undefined` (cai no estado "sem link", que já existe).

**Esforço:** 20 min.

---

### 8. Mensagem de erro apontando pra mecanismos que saíram da interface
**Onde:** `api/_lib/providers/internalSearchProvider.ts:586`

> "Use RapidAPI/Mercado Livre no seletor enquanto isso."

Nenhum dos dois está em `AB_TEST_PROVIDER_IDS` (`Dashboard.tsx`) — o usuário lê a instrução e
não acha a opção. Não é segurança, mas é o tipo de erro que faz o usuário achar que o app
está quebrado.

**Correção:** citar só o que está no seletor hoje (ScraperAPI, SearchApi.io por foto,
Motor interno + IA).

**Esforço:** 5 min.

---

## Precisão de busca — vale pra todos os mecanismos

Estes quatro primeiros atacam a causa dominante de "achou o produto errado" que sobrou
depois das correções de query e de similaridade já feitas.

### 9. Nenhuma sanidade de preço no ranqueamento
**Onde:** `api/_lib/rankCandidates.ts:84-116`

A escolha do candidato usa **só** similaridade de texto + popularidade. Preço não entra na
decisão em momento nenhum. Num app de arbitragem isso é o pior lugar pra ser cego: um
anúncio de acessório (R$ 9,90) ou de peça de reposição do produto certo passa fácil, e a
margem calculada sai fantasiosa.

**Correção:** função pura `assessPriceSanity(candidates)` — mediana dos preços dos candidatos
que passaram no filtro de similaridade; candidato abaixo de ~40% ou acima de ~250% da mediana
é rebaixado (ou marcado `approximate`, nunca escolhido em silêncio). Com 1 ou 2 candidatos
não há mediana confiável — nesse caso não penaliza nada (comportamento atual preservado).

**Esforço:** ~2h com testes.

---

### 10. Lote/kit vs unidade: a margem sai errada por construção
**Onde:** mesma cadeia (`rankCandidates.ts` + cada provider)

O catálogo dá preço **por unidade** ("Unid.CX: 13,50"), e o marketplace frequentemente anuncia
**caixa fechada** ("kit 12 unidades", "atacado 50 peças"). Hoje os dois viram o mesmo número e
`marginCalculator.ts` compara maçã com caixa de maçãs.

**Correção:** `detectPackQuantity(title)` (pura) reconhecendo `kit com N`, `N unidades`,
`caixa com N`, `pack N`, `atacado N` → dividir o preço do anúncio por N **ou** marcar a linha
como "preço de lote (N un.)" na tabela. Preferência: mostrar as duas informações, deixar o
cálculo com o preço por unidade.

**Esforço:** ~3h (é a mudança de maior retorno da lista inteira).

---

### 11. Contaminação por acessório
**Onde:** `api/_lib/textSimilarity.ts:57-63` (GENERIC_TOKENS) e `rankCandidates.ts:98`

"Capa para X", "suporte para X", "película para X", "adesivo X", "peça de reposição X"
compartilham quase todos os tokens com X — e com a tolerância de 0,1 + desempate por
popularidade, o acessório (sempre mais vendido) ganha.

**Correção:** lista `ACCESSORY_TOKENS`; se o token aparece no **título do candidato** mas não
no **nome do catálogo**, aplica penalidade fixa na similaridade (não descarta — catálogo de
acessório existe e aí o token está nos dois lados, então a penalidade não dispara).

**Esforço:** ~1h30.

---

### 12. A "confiança" exibida ignora a decisão visual
**Onde:** `api/_lib/textSimilarity.ts:133-136` (`confidenceFromSimilarity`) x
`visionInternalSearchProvider.ts` (score visual da IA)

Nos mecanismos por foto quem decide é a comparação visual, mas o número mostrado na tabela
continua derivado da similaridade de **texto**. O usuário lê 62% quando a IA disse 0,9 (ou o
contrário) — a coluna deixa de ser informação e vira ruído (é literalmente o problema que a
coluna foi criada pra resolver, ver comentário no topo daquele arquivo).

**Correção:** quando existir score visual, é ele que vira `confidence`; a UI diferencia a
origem ("confirmado por foto" x "similaridade de nome").

**Esforço:** ~1h.

---

### 13. Cache de 2h grava match ruim igual a match bom, e não dá pra forçar refresh
**Onde:** `api/_lib/cache.ts:4,63-89`; UI sem botão equivalente

Um match `approximate` (ou errado) fica cravado por 2 horas para aquele SKU e não há
"buscar de novo ignorando cache" em lugar nenhum da interface.

**Correção:** TTL curto (ex.: 15 min) ou nenhum cache pra resultado `approximate`;
botão "atualizar preço" por linha e um `?refresh=1` (com custo de cota) na requisição.

**Esforço:** ~2h.

---

### 14. Leitura de cache com N round-trips
**Onde:** `api/_lib/cache.ts:46-48`

```ts
const snaps = await Promise.all(skus.map((sku) => collection.doc(...).get()));
```

Um `.get()` por SKU. Com o cliente fatiando em 20 dá 20 leituras por lote; num catálogo de
4.500 produtos são 4.500 round-trips por marketplace, por busca.

**Correção:** `db.getAll(...refs)` em blocos de 300 — uma chamada por bloco, mesmo resultado.

**Esforço:** 40 min.

---

## Leitura de catálogo

### 15. `.xlsx` não é suportado
**Onde:** `src/lib/parseCatalog.ts:54-60`

Fornecedor manda planilha o tempo todo; hoje o app aceita só `.csv` e `.pdf`. A nota no
próprio arquivo já diz o caminho certo (tarball do CDN oficial do SheetJS, **não** o pacote
npm, que tem 2 CVEs abertas).

**Esforço:** ~2h.

---

### 16. Deduplicação só existe no PDF
**Onde:** `src/lib/parsePdfCatalog.ts` (`dedupeCatalogRows`, set/2026) x `parseCatalog.ts` (CSV)

A função é pura e recebe `CatalogRow[]` — dá pra reaproveitar no CSV (e no futuro XLSX) sem
tocar em nada além do ponto de chamada.

**Esforço:** 30 min.

---

### 17. Catálogo 100% imagem esbarra no teto de OCR sem instrução acionável
**Onde:** `src/lib/parsePdfCatalog.ts` (`MAX_OCR_PAGES_PER_CALL` = 25 desktop / 10 mobile)

Verificado com PDF real (`BMAX_limpo.pdf`: 11 páginas, zero texto embutido — passa; o BMAX
completo de 519 páginas, não). Hoje o excedente vira um `console.warn` que o usuário nunca vê.

**Correção:** quando o teto for atingido, devolver no aviso da tela o **intervalo exato**
que ficou de fora e um botão "processar páginas 26–50" já preenchido.

**Esforço:** ~1h30.

---

### 18. Preço ilegível pro OCR sem chave Gemini
**Onde:** `parsePdfCatalog.ts` (correção de preço via Gemini só roda com `geminiApiKey`)

Banner de preço colorido/diagonal é o caso comum nesse tipo de catálogo. Quem não tem chave
fica com o produto sem custo (`sem_custo`) e sem margem.

**Correção (barata, sem IA):** segunda passada do Tesseract só na faixa inferior do cartão,
com whitelist de caracteres (`0123456789,.R$`) e PSM de linha única — resolve boa parte dos
banners antes de precisar de IA.

**Esforço:** ~3h, com validação contra os PDFs reais que já estão no repositório de teste.

---

## Experiência do usuário

### 19. Não dá pra cancelar uma busca em andamento
Catálogo grande roda por minutos (lotes de 20, ou de 3 nos mecanismos com IA). Hoje só
recarregando a página — e aí perde o que já foi encontrado.
**Correção:** `AbortController` por lote + botão "parar e ficar com o que já achou". ~2h.

### 20. Não dá pra rebuscar só o que falhou
`Dashboard.tsx` já conta `failedItems`/`failedChunks`, mas a única saída é refazer tudo
(e pagar a cota de novo).
**Correção:** "tentar de novo só os N que falharam". ~1h30.

### 21. O motivo da falha é global, não por linha
O banner explica a causa do lote; a linha sem preço não diz **por quê** (bloqueio de loja,
sem candidato, rejeitado na comparação visual, sem foto extraída). Esse dado já existe no
servidor — só não viaja por item.
**Correção:** campo opcional `reason` por SKU na resposta, exibido no tooltip da linha. ~2h.

### 22. ETA e progresso mais honesto
Existe progresso por lote (`setProgress`) e estatística de velocidade por mecanismo
(`providerSpeedStats.ts`) — dá pra estimar o tempo restante com o que já está medido, sem
infraestrutura nova. ~1h.

### 23. Consumo real invisível
A barra de cota é informativa e não reflete o que a busca de fato gastou (créditos ScraperAPI,
chamadas de IA). Depois do item 3 (contador server-side), dá pra mostrar o número verdadeiro.
~1h30.

### 24. Onboarding do BYOK
Hoje o usuário descobre que precisa de chave quando a busca falha. Um passo curto na primeira
execução ("qual mecanismo você quer usar? este exige chave X, pegue aqui") corta a maior parte
das mensagens de erro de configuração. ~2h.

---

## Sequência sugerida

**Semana 1 — fechar o que está aberto (P0):** itens 1 → 3 → 2 → 4.
Item 1 é 30 minutos e hoje qualquer conta vira admin; os outros três estão na mesma trilha
(servidor passa a ser dono das chaves e da cota).

**Semana 2 — precisão:** itens 10 (lote/unidade) → 9 (sanidade de preço) → 11 (acessório) → 12.
Esse bloco é o que muda a percepção de "o app achou o produto errado".

**Semana 3 — higiene e experiência:** 5, 6, 7, 8, 14 (rápidos) + 19/20/21.

**Depois:** 15 (xlsx), 17, 18, 13, 22-24.

---

## O que está bem resolvido (não mexer)

- Autenticação nos endpoints (`verifyAuth.ts` + `adminAuth.ts`) — token verificado de verdade,
  com Admin SDK, e o gate de admin existe no servidor, não só na UI.
- Isolamento por usuário no Firestore via subcoleções (ADR-0003) — inclusive a decisão de
  tirar o cache de preço do escopo global, que evitava colisão de SKU entre catálogos.
- `secrets/` sem override de admin — está certo, mesmo com o item 1 aberto.
- Limpeza de query (`searchQuery.ts`) e filtro de termo genérico (`textSimilarity.ts`) — os
  dois atacaram causas reais e estão bem documentados.
- Isolamento de falha em todos os níveis (lote, página, produto, upload de foto): falha
  isolada nunca derruba o processamento inteiro.
- Cobertura de teste das funções puras (196 testes) — é o que permitiu auditar rápido.
