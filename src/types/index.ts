/**
 * Tipos compartilhados entre frontend e backend.
 *
 * Decisão de design: nada aqui é "Amazon-specific". O acoplamento a um
 * marketplace fica isolado em `lib/marketplaces/*` (client) e
 * `api/_lib/providers/*` (server). Isso é o que permite plugar Shopee e
 * Mercado Livre (roadmap Fase 4) sem mexer em types, marginCalculator ou
 * no contrato do endpoint. Ver docs/adr/0001-marketplace-adapter-pattern.md.
 */

/**
 * "geral" (ago/2026) — pseudo-marketplace OPT-IN: "qualquer loja
 * encontrada, fora de Amazon/Mercado Livre" (Shopee, Magalu, loja
 * própria...). Diferente de "shopee" (uma loja REAL específica, ainda sem
 * provider — ver comentário abaixo), "geral" nunca aponta pra uma loja
 * fixa; é resolvido em tempo de busca pelo motor interno + IA
 * (vision_internal, ver visionInternalSearchProvider.ts > Passo 4 /
 * fetchGoogleShoppingCandidatesForQuery) via Google Shopping estruturado
 * da ScraperAPI. Selecionável só quando esse provider está ativo (ver
 * Dashboard.tsx) — nos demais mecanismos compartilhados
 * (GOOGLE_SHOPPING_MATCHERS) o matcher existe mas não casa com nada de
 * propósito, então marcar "geral" com outro provider simplesmente não
 * traz produto nenhum por essa via, sem quebrar nada.
 */
export type MarketplaceId = "amazon" | "shopee" | "mercadolivre" | "geral";

/**
 * Qual API de busca resolve o preço — eixo independente de
 * MarketplaceId, escolhido pelo usuário na tela Dashboard (ver
 * SearchProviderId espelhado em api/_lib/types.ts pro mesmo motivo de
 * duplicação documentado no topo deste arquivo). "google_lens_products"
 * e "searchapi_lens" buscam por FOTO do produto (não por nome) — ver
 * catalogImages.ts, útil pra catálogos com nome genérico demais ("Faca
 * de corte"). "mercadolivre_alt" não aparece no seletor normal — é só a
 * alternativa paga oferecida quando "mercadolivre_direct" falha (ver
 * Dashboard.tsx > finishWithRows).
 *
 * "internal_search" (MOTOR PRÓPRIO, sem Gemini) foi REMOVIDO (ago/2026):
 * decisão do produto após a rodada de teste A/B — o motor interno seguiu
 * só na variante "vision_internal" (com IA), ver abaixo. A raspagem em si
 * (`fetchStoreOffers`, internalSearchProvider.ts) continua existindo —
 * "vision_internal" ainda depende dela pro passo de busca — só a rota de
 * busca por TEXTO sem IA saiu do seletor e do backend.
 *
 * "vision_internal" (ago/2026) — MOTOR INTERNO + IA: busca por FOTO sem
 * depender de SerpApi/SearchApi.io. Uma IA de visão (Gemini, BYOK, chave
 * própria em Conta) descreve a foto do catálogo em texto, a descrição
 * alimenta a mesma raspagem interna (fetchStoreOffers,
 * internalSearchProvider.ts), e os candidatos achados são confirmados
 * comparando a FOTO de cada um com a foto original — ver
 * visionInternalSearchProvider.ts.
 *
 * "vision_mistral" (ago/2026) — MESMA orquestração de "vision_internal"
 * acima, trocando o backend de IA de Gemini pra Mistral (BYOK, chave
 * própria em Conta, campo separado do Gemini) — ver `VisionBackend` em
 * api/_lib/providers/visionInternalSearchProvider.ts. Existe como 2ª
 * opção pra comparar diretamente com "vision_internal" (mesmo catálogo,
 * troca só o provider no seletor). SUBSTITUIU "vision_groq" (removido
 * ago/2026, relato real: "não traz nenhum resultado sequer" — o free tier
 * da Groq, 8.000 tokens/minuto, zerava a cota mesmo depois de otimizar as
 * chamadas em lote). O da Mistral (500.000 tokens/minuto, 1 req/segundo)
 * tem folga bem maior pro mesmo padrão de uso.
 *
 * "scraperapi" (ago/2026) — usa os "Structured Data Endpoints" da
 * ScraperAPI (Amazon Search API + Google Shopping API) — a própria
 * ScraperAPI faz o parsing e devolve JSON pronto, papel equivalente ao da
 * SerpApi/SearchApi.io — ver scraperApiSearchProvider.ts. Chave é BYOK
 * (set/2026 — antes era secret de servidor) — `needsKey: "scraperApiKey"`
 * em Dashboard.tsx. Continua o DEFAULT do seletor (cobre os dois
 * marketplaces com endpoints estruturados) depois da remoção de
 * "internal_search" acima, mesmo agora exigindo chave própria.
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
  | "scraperapi";

/**
 * Fonte de CANDIDATO pro motor interno + IA — ver o mesmo tipo (com a
 * justificativa completa) em api/_lib/types.ts. MANTER EM SINCRONIA.
 */
export type VisionCandidateSource = "auto" | "scraperapi" | "serpapi" | "searchapi";

/**
 * "home" — tela de entrada (ver docs/design-critique-log.md, Session 4):
 * saudação + números + atalho pra "Nova busca" (nome de tela continua
 * "dashboard" internamente; só o rótulo de navegação mudou, ver
 * TopNav.tsx). Vira o landing screen padrão no lugar de "dashboard".
 */
export type Screen =
  | "home"
  | "dashboard"
  | "pricing"
  | "results"
  | "portfolio"
  | "suppliers"
  | "account"
  | "settings"
  | "admin";

/**
 * Planos (Fase Planos): controlam (1) quais catálogos da biblioteca
 * administrável cada usuário enxerga e (2) o limite diário de buscas de
 * preço (proteção de cota da SerpApi). Definição de cada plano em
 * `config/plans.ts` — aqui só o identificador, pra não criar dependência
 * circular entre `types` e `config`.
 */
export type PlanId = "free" | "starter" | "pro";

export interface CatalogRow {
  sku: string;
  name: string;
  /**
   * Preço de custo (fornecedor) — ausente em catálogos "vitrine" que só
   * mostram SKU/nome/foto sem preço nenhum (ver extractProductBlocksWithoutPrice
   * em parsePdfCatalog.ts). Nesse caso o app ainda busca preço de
   * mercado normalmente, só não calcula margem (ver marginCalculator.ts
   * e o valor "sem_custo" de Recommendation) — decisão explícita do
   * usuário (ago/2026): melhor mostrar o preço de mercado sem margem do
   * que descartar o produto inteiro.
   */
  supplierPrice?: number;
  /**
   * URL pública da foto do produto (ver catalogImages.ts) — só existe
   * quando a busca rodou em modo imagem (Google Lens). Persiste junto
   * com a linha em `catalog_uploads` (catalogHistory.ts), então some
   * quando o documento em `catalog_images` expira (TTL, ver
   * catalogImages.ts) mesmo que o registro do histórico continue vivo —
   * a tela de Resultados trata isso com fallback pra ícone genérico.
   */
  imageUrl?: string;
}

/**
 * O que um provider precisa pra buscar preço de 1 item. SKU sozinho não
 * basta: providers oficiais tipo SP-API resolvem por SKU (é o vendedor
 * consultando o próprio catálogo), mas busca pública (Mercado Livre,
 * futuramente Google Shopping etc.) só funciona buscando pelo `name` —
 * não existe "SKU do fornecedor" nesses catálogos. Ver ADR-0001.
 */
export interface CatalogItemQuery {
  sku: string;
  name: string;
  /** Ver mesmo campo em api/_lib/types.ts — URL pública temporária da foto do produto. */
  imageUrl?: string;
  /** Ver mesmo campo em api/_lib/types.ts — custo do catálogo, usado no servidor só como âncora de sanidade de preço. */
  supplierPrice?: number;
}

export interface MarketplacePriceResult {
  marketplace: MarketplaceId;
  sku: string;
  price: number;
  competitorCount: number;
  buyBoxEligible: boolean;
  /** 0..1 — confiança no dado retornado (1 = validado pela API oficial, mais baixo em match por busca textual) */
  confidence: number;
  /** URL do produto encontrado, quando o provider faz busca real */
  link?: string;
  /** Título/nome exatamente como retornado pelo marketplace — pra conferir se o match faz sentido */
  matchedTitle?: string;
  /**
   * Foto do ANÚNCIO encontrado (thumbnail do marketplace) — diferente de
   * `CatalogRow.imageUrl`, que é a foto do PRÓPRIO catálogo do
   * fornecedor. `marginCalculator.ts` prioriza esta aqui (mais útil pra
   * conferir se o match faz sentido) e cai pra `CatalogRow.imageUrl` só
   * quando o provider/item encontrado não trouxe foto nenhuma.
   */
  imageUrl?: string;
  /** Ver mesmo campo (com a justificativa completa) em api/_lib/types.ts. */
  approximate?: boolean;
  /** Loja de onde o anúncio veio de fato — usada na tag "Aproximado". */
  matchedSource?: string;
  /** Ver mesmo campo (com a justificativa completa) em api/_lib/types.ts — quantidade do LOTE anunciado. */
  packQuantity?: number;
  /** Ver mesmo campo em api/_lib/types.ts — preço por unidade quando o anúncio é lote. */
  unitPrice?: number;
  /** Ver mesmo campo em api/_lib/types.ts — preço incompatível com o custo do catálogo. */
  priceSanityFlag?: "abaixo_do_custo" | "muito_acima_do_custo";
  /** Ver mesmo campo em api/_lib/types.ts — o que decidiu o match (foto x nome). */
  confidenceSource?: "visual" | "texto";
  /** Ver mesmo campo em api/_lib/types.ts — avaliações (Amazon) ou vendas (ML) do anúncio encontrado. */
  reviewCount?: number;
  /** Ver mesmo campo em api/_lib/types.ts — nota média (0-5) do anúncio encontrado. */
  rating?: number;
}

export interface MarketplaceFee {
  id: string;
  name: string;
  /** 0..1 */
  rate: number;
  enabled: boolean;
}

export interface ShippingTier {
  id: string;
  label: string;
  maxPrice: number;
  cost: number;
}

export interface TaxRate {
  id: string;
  state: string;
  label: string;
  /** 0..1 */
  rate: number;
  enabled: boolean;
}

export interface PricingRules {
  marketplaceFees: MarketplaceFee[];
  shippingTiers: ShippingTier[];
  taxRates: TaxRate[];
  /** 0..1 */
  targetMarginPct: number;
  priceFloor: number;
}

/**
 * "sem_custo" — catálogo sem preço de fornecedor (ver CatalogRow.supplierPrice);
 * o produto tem preço de MERCADO encontrado, mas nenhuma margem calculável.
 * Fica de fora dos badges normais (não é "recomendado" nem "evitar" — não
 * há custo pra julgar) e fora dos totais de recomendado/evitar na tela de
 * Resultados, mas segue visível e exportável (só sem coluna de margem).
 */
export type Recommendation = "recomendado" | "revisar" | "evitar" | "sem_custo";

export interface MarginResult {
  sku: string;
  name: string;
  /** Ver CatalogRow.supplierPrice — ausente quando `recommendation === "sem_custo"`, e só nesse caso. */
  supplierPrice?: number;
  marketplacePrice: number;
  marketplace: MarketplaceId;
  /** Indefinido junto com supplierPrice (ver acima) — sem custo não há como ratear taxa/frete/imposto em cima de margem nenhuma. */
  feesCost?: number;
  shippingCost?: number;
  taxesCost?: number;
  totalCost?: number;
  marginPct?: number;
  confidence: number;
  recommendation: Recommendation;
  link?: string;
  matchedTitle?: string;
  /** Ver mesmo campo em CatalogRow — copiado ao calcular a margem (marginCalculator.ts). */
  imageUrl?: string;
  /**
   * Match não confiável (outra loja ou similaridade baixa) — copiado de
   * MarketplacePriceResult em calculateMargin(). Vira a tag "Aproximado"
   * na tela de Resultados; margem calculada em cima de um preço
   * aproximado continua sendo uma estimativa, não um número pra decidir
   * compra sem conferir o anúncio.
   */
  approximate?: boolean;
  /**
   * Preço CHEIO do anúncio quando ele vende lote — só preenchido nesse
   * caso (ver `packQuantity` abaixo e packQuantity.ts). `marketplacePrice`
   * acima carrega o preço POR UNIDADE, que é o comparável com o custo do
   * catálogo e o que entra na margem; este campo existe pra tela poder
   * mostrar também o número que o usuário vai encontrar ao abrir o link,
   * senão o preço exibido não bateria com o do anúncio.
   */
  listingPrice?: number;
  /** Quantidade de unidades do lote anunciado — ver mesmo campo em MarketplacePriceResult. */
  packQuantity?: number;
  /** Preço incompatível com o custo do catálogo — ver mesmo campo em MarketplacePriceResult e priceSanity.ts. */
  priceSanityFlag?: "abaixo_do_custo" | "muito_acima_do_custo";
  /** O que decidiu o match (foto x nome) — ver mesmo campo em MarketplacePriceResult. */
  confidenceSource?: "visual" | "texto";
  /** Loja real de origem do preço — mostrada junto da tag "Aproximado". */
  matchedSource?: string;
  /**
   * Nº de outros vendedores encontrados pro mesmo anúncio e se este
   * resultado é elegível ao "ganha-compra" (Buy Box/comprar com este
   * vendedor) — ambos já calculados por todo provider (ver
   * MarketplacePriceResult), só não chegavam até a UI antes; copiados
   * em calculateMargin() igual aos outros campos desta seção.
   */
  competitorCount: number;
  buyBoxEligible: boolean;
  /**
   * Popularidade do anúncio (avaliações na Amazon, vendas no ML) —
   * copiada de MarketplacePriceResult em calculateMargin(). Vira o badge
   * de popularidade na tela de Resultados: um preço vindo de anúncio com
   * milhares de vendas é referência de mercado muito mais forte do que o
   * mesmo preço vindo de um anúncio sem histórico.
   */
  reviewCount?: number;
  /** Nota média (0-5) do anúncio — ver `reviewCount`. */
  rating?: number;
}

export interface MarginSummary {
  totalSkus: number;
  totalProfitable: number;
  avgMarginPct: number;
  /** Robusta a outlier — preferir esta pro KPI de destaque (ver marginCalculator.ts). */
  medianMarginPct: number;
}
