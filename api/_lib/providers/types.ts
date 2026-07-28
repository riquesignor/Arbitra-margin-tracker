import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types";

/**
 * Espelha src/lib/marketplaces/types.ts no lado servidor. Recebe
 * `{sku, name}` (não só sku) — busca pública (Mercado Livre) só resolve
 * por nome; SP-API resolveria por sku (catálogo próprio do vendedor).
 * Cada marketplace em seu próprio arquivo implementando
 * `ServerPriceProvider`, registrado uma vez em registry.ts.
 */
export interface ServerPriceProvider {
  readonly id: MarketplaceId;
  /**
   * `apiKey` opcional (BYOK — ver src/lib/userSecrets.ts): quando o
   * usuário tem chave própria da SerpApi, ela chega até aqui e o
   * provider usa em vez da `SERPAPI_KEY` compartilhada do servidor.
   * Providers que não usam chave externa (mock, Mercado Livre OAuth)
   * simplesmente ignoram o parâmetro.
   */
  fetchPrices(
    items: CatalogItemQuery[],
    apiKey?: string
  ): Promise<Record<string, MarketplacePriceResult>>;
}
