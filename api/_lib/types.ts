/**
 * Contrato de dados do backend. Duplicado (não importado) de src/types —
 * decisão deliberada: frontend e backend usam tsconfigs diferentes (DOM vs
 * Node) e ficam buildáveis/deployáveis de forma independente. O preço da
 * duplicação é sincronizar manualmente se o shape mudar; se isso doer,
 * extrair pra um pacote `packages/shared` (workspace) resolve — ver
 * docs/adr/0001-marketplace-adapter-pattern.md > Consequências.
 */
/**
 * "geral" (ago/2026) — pseudo-marketplace OPT-IN: "qualquer loja
 * encontrada, fora de Amazon/Mercado Livre" (Shopee, Magalu, loja
 * própria...). Resolvido em tempo de busca pelo motor interno + IA
 * (vision_internal, ver visionInternalSearchProvider.ts > Passo 4) via
 * Google Shopping estruturado da ScraperAPI — não tem provider próprio
 * fixo como "shopee" (esse sim, uma loja real específica, ainda sem
 * provider). Presente em GOOGLE_SHOPPING_MATCHERS (googleShoppingProvider.ts)
 * com `matchesSource` sempre `false` pros OUTROS mecanismos — inerte lá
 * de propósito, sem quebrar nada; só "vision_internal" trata de verdade.
 */
export type MarketplaceId = "amazon" | "shopee" | "mercadolivre" | "geral";

/**
 * Qual API de busca resolve o preço — eixo INDEPENDENTE de MarketplaceId
 * (ver api/_lib/providers/registry.ts). Um marketplace pode ser buscado
 * por mais de um provider (ex: "amazon" via SerpApi/Google Shopping OU
 * via RapidAPI direto); o usuário escolhe qual usar por busca, não fixo
 * por conta — ver Dashboard.tsx.
 *   - "serpapi"            → Google Shopping (SerpApi), cobre amazon +
 *     mercadolivre numa busca só (googleShoppingProvider.ts).
 *   - "rapidapi_amazon"    → Amazon direto via RapidAPI ("Real-Time
 *     Amazon Data"), só cobre marketplace amazon.
 *   - "mercadolivre_direct" → endpoint público do Mercado Livre, sem
 *     chave — só cobre marketplace mercadolivre. Instável (ver
 *     mercadoLivreDirectProvider.ts).
 *   - "mercadolivre_alt" → alternativa PAGA ao endpoint público acima
 *     (Unwrangle Mercado Livre Search API, BYOK) — só cobre mercadolivre,
 *     mesmo grupo "direto" que "mercadolivre_direct" e "rapidapi_amazon".
 *     Existe só pra quando o endpoint público falha (ver
 *     unwrangleMercadoLivreProvider.ts e o fluxo de fallback em
 *     Dashboard.tsx > finishWithRows): não é uma opção de busca normal
 *     no seletor, é oferecida como "tentar de novo com sua chave" quando
 *     "mercadolivre_direct" dá erro E o usuário já tem a chave cadastrada.
 *   - "google_lens_products" → busca por IMAGEM (Google Lens via
 *     SerpApi, mesma chave da SerpApi acima), cobre amazon +
 *     mercadolivre igual "serpapi" — só muda o insumo (foto do produto
 *     em vez do nome em texto). Ver googleLensProvider.ts. Existe pra
 *     catálogos com nome genérico demais ("Faca de corte") onde busca
 *     por texto acha qualquer coisa — precisa de `imageUrl` por item
 *     (ver CatalogItemQuery abaixo), não funciona sem foto.
 *   - "searchapi_lens" → segunda API de busca por FOTO, vendor diferente
 *     (SearchApi.io, BYOK própria) espelhando o mesmo Google Lens que
 *     "google_lens_products" usa via SerpApi — existe só como
 *     redundância (cota/downtime de um não afeta o outro), ver
 *     searchApiLensProvider.ts. Mesmo grupo multi-marketplace de
 *     "google_lens_products".
 *   - "internal_search" (MOTOR INTERNO sem IA) foi REMOVIDO (ago/2026) —
 *     decisão de produto pós teste A/B: o motor interno seguiu só na
 *     variante "vision_internal" (com Gemini), abaixo. A função
 *     `searchInternalShared` foi removida de internalSearchProvider.ts,
 *     mas a raspagem em si (`fetchStoreOffers`, mesmo arquivo) continua —
 *     "vision_internal" ainda depende dela pro passo de busca por texto.
 *   - "vision_internal" → MOTOR INTERNO + IA (ago/2026): busca por FOTO
 *     sem SerpApi/SearchApi.io. Gemini (BYOK, chave própria em Conta)
 *     descreve a foto do catálogo, a descrição vira query pra
 *     `fetchStoreOffers` (raspagem direta Amazon+ML, internalSearchProvider.ts),
 *     e os candidatos achados são confirmados comparando foto-com-foto
 *     via IA — ver visionInternalSearchProvider.ts e geminiVision.ts.
 *     Quando nem Amazon nem Mercado Livre confirmam visualmente,
 *     complementa com busca geral (várias lojas) via Google Shopping
 *     estruturado da ScraperAPI — mesmo fallback "aproximado" que
 *     "serpapi"/"scraperapi"/"searchapi_lens"/"google_lens_products" já
 *     tinham, ver `fetchGoogleShoppingCandidatesForQuery` em
 *     scraperApiSearchProvider.ts.
 *   - "vision_mistral" (ago/2026) → MESMA orquestração de "vision_internal"
 *     acima (busca por foto, raspagem Amazon+ML, confirmação visual,
 *     busca geral), mas com Mistral (BYOK, chave própria em Conta, campo
 *     separado do Gemini) no lugar do Gemini pra descrever/comparar foto —
 *     ver `VisionBackend` em visionInternalSearchProvider.ts e
 *     mistralVision.ts pro porquê de existir. SUBSTITUIU "vision_groq"
 *     (removido ago/2026): o free tier da Groq (8.000 tokens/minuto)
 *     zerava resultado mesmo depois de otimizar as chamadas em lote — o
 *     da Mistral (500.000 tokens/minuto, 1 req/segundo) tem folga bem
 *     maior pro mesmo padrão de uso (várias comparações visuais por
 *     produto).
 *   - "vision_nvidia" (set/2026, BETA) → MESMA orquestração acima, 3º
 *     backend de IA (BYOK, campo próprio em Conta) ao lado de Gemini e
 *     Mistral — ver nvidiaVision.ts. Servido via NVIDIA NIM
 *     (build.nvidia.com), free tier sem cartão. Marcado "Beta" no
 *     seletor (Dashboard.tsx) até validação real de acurácia/latência —
 *     é opção A MAIS pro usuário comparar, não substitui as outras duas.
 *   - "scraperapi" → Structured Data Endpoints da ScraperAPI (Amazon
 *     Search API nativa + Google Shopping API), a própria ScraperAPI faz
 *     o parsing e devolve JSON pronto — papel equivalente ao de "serpapi"
 *     — ver scraperApiSearchProvider.ts. Chave é BYOK (set/2026 — antes
 *     era secret de servidor): o servidor resolve `scraperApiKey` pelo
 *     uid autenticado (`getUserScraperApiKey`, userSecrets.ts), nunca do
 *     corpo da requisição. Continua o default do seletor depois da
 *     remoção de "internal_search" acima, mesmo agora exigindo chave
 *     própria.
 */
export type SearchProviderId =
  | "serpapi"
  | "rapidapi_amazon"
  | "mercadolivre_direct"
  | "mercadolivre_alt"
  | "google_lens_products"
  | "searchapi_lens"
  | "vision_internal"
  | "vision_mistral"
  | "vision_nvidia"
  | "scraperapi";

/**
 * Fonte de CANDIDATO pro motor interno + IA ("vision_internal"/
 * "vision_mistral", set/2026) — eixo ORTOGONAL a qual backend de IA
 * resolve descrição/comparação visual (Gemini/Mistral, ver VisionBackend
 * em visionInternalSearchProvider.ts), mesma relação que este arquivo já
 * tem entre MarketplaceId e SearchProviderId. Escolhido pelo usuário
 * (pop-up ao selecionar um dos dois motores internos, ver Dashboard.tsx) —
 * antes disso a escolha entre raspagem/oficial/ScraperAPI era 100%
 * automática (a cascata abaixo), sem controle nenhum do usuário.
 *
 *   - "auto" (default) — cascata de sempre em `fetchCandidateOffers`
 *     (visionInternalSearchProvider.ts): raspagem direta (via proxy
 *     ScraperAPI quando há chave) → API oficial grátis (PA-API Amazon /
 *     OAuth Mercado Livre) → ScraperAPI estruturado. Continua passando
 *     pela comparação visual do backend de IA escolhido.
 *   - "scraperapi" — pula os dois primeiros degraus (raspagem + oficial)
 *     e vai direto pro Structured Data Endpoint da ScraperAPI, evitando de
 *     propósito o risco de bloqueio 403 da raspagem direta. Ainda passa
 *     pela comparação visual do backend de IA — troca só a FONTE de
 *     candidato, não o pipeline de confirmação. Mais lento (uma chamada de
 *     IA por candidato), mais preciso (confirmação visual de verdade).
 *   - "serpapi" / "searchapi" — BYPASSA o pipeline de IA de visão inteiro:
 *     delega a busca pro provider standalone já existente
 *     (`searchGoogleShoppingShared`/`searchSearchApiLensShared`) e usa o
 *     resultado dele direto, sem chamar Gemini/Mistral. Mais rápido (1
 *     chamada por produto, sem loop de comparação por candidato), porém
 *     mais parcial: "serpapi" decide por similaridade de TEXTO (não usa a
 *     foto do catálogo pra nada); "searchapi" usa o Google Lens dele
 *     (foto de verdade, mesma fonte que `searchapi_lens` já usa como
 *     provider standalone). Nenhum dos dois usa o backend de IA escolhido
 *     no seletor — a chave Gemini/Mistral continua sendo exigida mesmo
 *     assim (trade-off aceito pra não complicar o `needsKey` estático por
 *     provider em Dashboard.tsx com uma sub-escolha condicional).
 */
export type VisionCandidateSource = "auto" | "scraperapi" | "serpapi" | "searchapi";

export interface CatalogItemQuery {
  sku: string;
  name: string;
  /**
   * URL pública temporária da foto do produto no catálogo (ver
   * src/lib/catalogImages.ts + api/catalog-image.ts) — só usada pelo
   * provider "google_lens_products". Ausente = esse item não tem foto
   * disponível (ex: catálogo CSV, ou linha do PDF sem imagem
   * reconhecida) e é pulado silenciosamente pela busca por imagem.
   */
  imageUrl?: string;
  /**
   * Custo de fornecedor do catálogo (set/2026) — mandado pro servidor
   * como ÂNCORA de sanidade de preço (ver priceSanity.ts), não pra
   * cálculo: a margem continua sendo calculada no cliente
   * (marginCalculator.ts). Ausente em catálogo "vitrine" (sem preço de
   * custo), e nesse caso a checagem simplesmente não roda.
   */
  supplierPrice?: number;
}

export interface MarketplacePriceResult {
  marketplace: MarketplaceId;
  sku: string;
  price: number;
  competitorCount: number;
  buyBoxEligible: boolean;
  confidence: number;
  link?: string;
  matchedTitle?: string;
  /** Foto do anúncio encontrado (thumbnail do marketplace) — ver mesmo campo em src/types/index.ts. */
  imageUrl?: string;
  /**
   * true = este resultado NÃO é um match confiável do marketplace pedido
   * — ou veio de outra loja (fallback, ver providers), ou a similaridade
   * com o nome do catálogo ficou baixa demais pra afirmar que é o mesmo
   * produto. A UI marca com a tag "Aproximado" (ver ResultsTable.tsx).
   * Existe porque descartar esses resultados em silêncio fazia um
   * catálogo de dezenas de produtos voltar com 2 linhas, sem nenhuma
   * pista do porquê — melhor mostrar tudo e ser explícito sobre o que é
   * chute.
   */
  approximate?: boolean;
  /** Loja de onde o anúncio veio de fato (`source` cru do provider) — sem isso a tag "Aproximado" não teria como dizer de ONDE veio o preço. */
  matchedSource?: string;
  /**
   * Quantidade de unidades que o ANÚNCIO entrega, quando o título diz
   * explicitamente que é lote ("kit com 12", "atacado 50 peças" — ver
   * detectPackQuantity em packQuantity.ts). `undefined` = anúncio unitário
   * (o caso comum) OU título sem padrão reconhecível; nos dois casos
   * `price` já é o preço de uma unidade.
   */
  packQuantity?: number;
  /**
   * `price / packQuantity` — o número comparável com o custo unitário do
   * catálogo (set/2026, ver docs/auditoria-2026-09.md > item 10). Existe
   * porque comparar o preço de um LOTE com o custo de UMA peça produzia
   * margem fantasiosa justamente nos anúncios de atacado, que é o que
   * mais aparece nesse tipo de busca. `undefined` quando não há lote.
   */
  unitPrice?: number;
  /**
   * Preço fora da faixa plausível em relação ao custo de fornecedor do
   * catálogo (ver priceSanity.ts). Vem junto com `approximate: true` — a
   * UI usa o flag pra explicar POR QUE o resultado é suspeito, em vez do
   * aviso genérico de "aproximado".
   */
  priceSanityFlag?: "abaixo_do_custo" | "muito_acima_do_custo";
  /**
   * O que DECIDIU este match (set/2026, ver docs/auditoria-2026-09.md >
   * item 12): comparação da FOTO (mecanismos por imagem — Google Lens,
   * SearchApi.io, motor interno + IA) ou similaridade do NOME (mecanismos
   * por texto). A coluna "Confiança" mostrava um número sem dizer de onde
   * ele vinha — 62% por semelhança de string e 62% por confirmação visual
   * têm significados bem diferentes na hora de decidir compra.
   */
  confidenceSource?: "visual" | "texto";
  /**
   * Popularidade do ANÚNCIO encontrado (set/2026): nº de avaliações na
   * Amazon, nº de vendas no Mercado Livre ("+1000 vendidos") — ver
   * `ScrapedOffer.reviewCount` em internalSearchProvider.ts. O dado já
   * era extraído e já pesava no desempate entre candidatos
   * (`popularityScore` em rankCandidates.ts), mas morria no servidor:
   * nada na tela dizia se o preço veio de um anúncio que vende de
   * verdade ou de um anúncio parado. Ausente quando a fonte não expõe o
   * sinal (Google Shopping estruturado, por exemplo, não devolve isso de
   * forma confiável).
   */
  reviewCount?: number;
  /** Nota média do anúncio (0-5), quando a fonte expõe — ver `reviewCount`. */
  rating?: number;
}
