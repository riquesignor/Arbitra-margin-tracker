import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types.js";
import type { ServerPriceProvider } from "./types.js";

function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return Math.abs(hash);
}

/**
 * Provider mock server-side — placeholder até `spApiPricing.ts` (SP-API
 * real) ser implementado e registrado no lugar deste, sem tocar em
 * fetch-prices.ts, cache.ts ou no contrato HTTP do endpoint.
 */
export function createServerMockProvider(id: MarketplaceId): ServerPriceProvider {
  return {
    id,
    async fetchPrices(items: CatalogItemQuery[]) {
      const results: Record<string, MarketplacePriceResult> = {};
      for (const { sku } of items) {
        const seed = hashString(`${id}:${sku}`);
        const price = 20 + (seed % 48000) / 100;
        results[sku] = {
          marketplace: id,
          sku,
          price: Number(price.toFixed(2)),
          competitorCount: seed % 8,
          buyBoxEligible: seed % 5 !== 0,
          confidence: 0.7,
        };
      }
      return results;
    },
  };
}
