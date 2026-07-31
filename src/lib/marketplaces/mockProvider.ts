import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../../types";
import type { PriceProvider } from "./types";

/** Hash determinístico simples (djb2) — mesma SKU sempre gera o mesmo preço mock. */
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return Math.abs(hash);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Provider mock genérico: qualquer marketplace pode usar isso como
 * implementação default até o adapter real (API oficial ou busca) estar
 * pronto. Simula latência de rede (250–700ms) pra UI se comportar igual
 * à produção. Usa só `sku` pro hash (determinístico); `name` é ignorado
 * aqui porque mock não faz busca de verdade.
 */
export function createMockProvider(id: MarketplaceId, label: string): PriceProvider {
  return {
    id,
    label,
    async fetchPrices(items: CatalogItemQuery[]) {
      const skus = items.map((i) => i.sku);
      await sleep(250 + (hashString(skus.join(",")) % 450));

      const results: Record<string, MarketplacePriceResult> = {};
      for (const sku of skus) {
        const seed = hashString(`${id}:${sku}`);
        const price = 20 + (seed % 48000) / 100; // R$20.00 – R$500.00
        results[sku] = {
          marketplace: id,
          sku,
          price: Number(price.toFixed(2)),
          competitorCount: seed % 8,
          buyBoxEligible: seed % 5 !== 0,
          confidence: 0.7, // mock nunca chega em 0.95+ (reservado pra dado real)
        };
      }
      return results;
    },
  };
}
