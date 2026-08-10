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
 */
export type SearchProviderId =
  | "serpapi"
  | "rapidapi_amazon"
  | "mercadolivre_direct"
  | "mercadolivre_alt"
  | "google_lens_products"
  | "searchapi_lens";

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
  /** Foto do anúncio encontrado (thumbnail do marketplace) — ver mesmo campo em src/types/index.ts. */
  imageUrl?: string;
}
