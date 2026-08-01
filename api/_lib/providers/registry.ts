import type { MarketplaceId } from "../types.js";
import type { ServerPriceProvider } from "./types.js";
import { GOOGLE_SHOPPING_MATCHERS } from "./googleShoppingProvider.js";

const registry = new Map<MarketplaceId, ServerPriceProvider>();

export function registerProvider(provider: ServerPriceProvider): void {
  registry.set(provider.id, provider);
}

export function getProvider(id: MarketplaceId): ServerPriceProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw new Error(`Nenhum ServerPriceProvider registrado para "${id}"`);
  }
  return provider;
}

/**
 * Marketplaces resolvidos via busca COMPARTILHADA no Google Shopping —
 * ver googleShoppingProvider.ts e fetch-prices.ts. `getProvider` acima
 * continua existindo pra qualquer marketplace FORA desse grupo (futuro
 * Amazon SP-API real, Mercado Livre OAuth real — ver alternativas
 * parked abaixo), mas amazon/mercadolivre hoje não passam mais por ele.
 */
export function isGoogleShoppingMarketplace(id: MarketplaceId): boolean {
  return GOOGLE_SHOPPING_MATCHERS.some((m) => m.marketplace === id);
}

// --- Registro default ---
// Amazon e Mercado Livre são resolvidos direto em fetch-prices.ts via
// GOOGLE_SHOPPING_MATCHERS + searchGoogleShoppingShared (1 busca por
// produto cobrindo os dois, ver docs/architecture-review.md item 15) —
// por isso NENHUM dos dois está registrado aqui via registerProvider.
// Esse registro (`getProvider`/`registerProvider`) segue existindo pra
// qualquer provider que precise de uma chamada própria, independente,
// não compartilhável com Google Shopping:
//   - createServerMockProvider("amazon")            (./mockProvider.ts)
//   - createMercadoLivreSearchProvider()             (./mercadoLivreSearchProvider.ts,
//     autenticado via mlAuth.ts — funciona, mas exige concluir o setup
//     OAuth em scripts/ml-oauth-setup.mjs, que esbarra em validação de
//     titularidade no DevCenter do Mercado Livre)
