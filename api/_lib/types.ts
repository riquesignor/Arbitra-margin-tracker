/**
 * Contrato de dados do backend. Duplicado (não importado) de src/types —
 * decisão deliberada: frontend e backend usam tsconfigs diferentes (DOM vs
 * Node) e ficam buildáveis/deployáveis de forma independente. O preço da
 * duplicação é sincronizar manualmente se o shape mudar; se isso doer,
 * extrair pra um pacote `packages/shared` (workspace) resolve — ver
 * docs/adr/0001-marketplace-adapter-pattern.md > Consequências.
 */
export type MarketplaceId = "amazon" | "shopee" | "mercadolivre";

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
 *   - "google_lens_products" → busca por IMAGEM (Google Lens via
 *     SerpApi, mesma chave da SerpApi acima), cobre amazon +
 *     mercadolivre igual "serpapi" — só muda o insumo (foto do produto
 *     em vez do nome em texto). Ver googleLensProvider.ts. Existe pra
 *     catálogos com nome genérico demais ("Faca de corte") onde busca
 *     por texto acha qualquer coisa — precisa de `imageUrl` por item
 *     (ver CatalogItemQuery abaixo), não funciona sem foto.
 */
export type SearchProviderId =
  | "serpapi"
  | "rapidapi_amazon"
  | "mercadolivre_direct"
  | "google_lens_products";

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
}
