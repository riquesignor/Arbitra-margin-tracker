/**
 * Tipos compartilhados entre frontend e backend.
 *
 * Decisão de design: nada aqui é "Amazon-specific". O acoplamento a um
 * marketplace fica isolado em `lib/marketplaces/*` (client) e
 * `api/_lib/providers/*` (server). Isso é o que permite plugar Shopee e
 * Mercado Livre (roadmap Fase 4) sem mexer em types, marginCalculator ou
 * no contrato do endpoint. Ver docs/adr/0001-marketplace-adapter-pattern.md.
 */

export type MarketplaceId = "amazon" | "shopee" | "mercadolivre";

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
 * "internal_search" é o MOTOR PRÓPRIO (ago/2026): lê o preço direto da
 * página de busca das lojas, sem chave e sem custo por busca — virou o
 * default da busca por texto. Com ele, "serpapi" saiu do fluxo de PDF
 * simples e ficou reservada à busca por FOTO.
 *
 * "vision_internal" (ago/2026) — MOTOR INTERNO + IA: busca por FOTO sem
 * depender de SerpApi/SearchApi.io. Uma IA de visão (Gemini, BYOK, chave
 * própria em Conta) descreve a foto do catálogo em texto, a descrição
 * alimenta o mesmo motor interno de "internal_search", e os candidatos
 * achados são confirmados comparando a FOTO de cada um com a foto
 * original — ver visionInternalSearchProvider.ts. Existe pra tirar a
 * dependência de API paga por busca de foto também, não só na busca por
 * texto; ainda é opção adicional ao lado de "google_lens_products"/
 * "searchapi_lens", não substituição — precisa validar taxa de acerto em
 * uso real antes de virar default.
 *
 * "scraperapi" (ago/2026) — 3º mecanismo do teste A/B de terceiros. Usa os
 * "Structured Data Endpoints" da ScraperAPI (Amazon Search API + Google
 * Shopping API) — a própria ScraperAPI faz o parsing e devolve JSON pronto,
 * papel equivalente ao da SerpApi/SearchApi.io. Diferente de
 * "internal_search" (que também usa a mesma SCRAPERAPI_KEY, mas só como
 * PROXY de transporte pro parser próprio) — ver scraperApiSearchProvider.ts.
 * Chave é secret de servidor (`SCRAPERAPI_KEY`), não BYOK — `needsKey: null`
 * em Dashboard.tsx, mesmo padrão de "internal_search".
 */
export type SearchProviderId =
  | "internal_search"
  | "serpapi"
  | "rapidapi_amazon"
  | "mercadolivre_direct"
  | "mercadolivre_alt"
  | "google_lens_products"
  | "searchapi_lens"
  | "vision_internal"
  | "scraperapi";

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
}

export interface MarginSummary {
  totalSkus: number;
  totalProfitable: number;
  avgMarginPct: number;
  /** Robusta a outlier — preferir esta pro KPI de destaque (ver marginCalculator.ts). */
  medianMarginPct: number;
}
