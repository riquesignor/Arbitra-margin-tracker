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
 * busca por FOTO do produto (não por nome) — ver catalogImages.ts,
 * useful pra catálogos com nome genérico demais ("Faca de corte").
 */
export type SearchProviderId =
  | "serpapi"
  | "rapidapi_amazon"
  | "mercadolivre_direct"
  | "google_lens_products";

export type Screen = "dashboard" | "pricing" | "results" | "account" | "admin";

/**
 * Planos (Fase Planos): controlam (1) quais catálogos da biblioteca
 * administrável cada usuário enxerga e (2) o limite diário de buscas de
 * preço (proteção de cota da SerpApi). Definição de cada plano em
 * `config/plans.ts` — aqui só o identificador, pra não criar dependência
 * circular entre `types` e `config`.
 */
export type PlanId = "iniciante" | "profissional";

export interface CatalogRow {
  sku: string;
  name: string;
  supplierPrice: number;
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

export type Recommendation = "recomendado" | "revisar" | "evitar";

export interface MarginResult {
  sku: string;
  name: string;
  supplierPrice: number;
  marketplacePrice: number;
  marketplace: MarketplaceId;
  feesCost: number;
  shippingCost: number;
  taxesCost: number;
  totalCost: number;
  marginPct: number;
  confidence: number;
  recommendation: Recommendation;
  link?: string;
  matchedTitle?: string;
}

export interface MarginSummary {
  totalSkus: number;
  totalProfitable: number;
  avgMarginPct: number;
  /** Robusta a outlier — preferir esta pro KPI de destaque (ver marginCalculator.ts). */
  medianMarginPct: number;
}
