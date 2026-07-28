import type { MarketplaceId } from "../../types";
import type { PriceProvider } from "./types";
import { createMockProvider } from "./mockProvider";

const registry = new Map<MarketplaceId, PriceProvider>();

export function registerProvider(provider: PriceProvider): void {
  registry.set(provider.id, provider);
}

export function getProvider(id: MarketplaceId): PriceProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw new Error(`Nenhum PriceProvider registrado para o marketplace "${id}"`);
  }
  return provider;
}

export function listProviders(): PriceProvider[] {
  return Array.from(registry.values());
}

// --- Registro default ---
// Os dois em mock aqui no client. A busca REAL (Google Shopping via
// SerpApi, ver api/_lib/providers/googleShoppingProvider.ts) só roda no
// servidor — a API key não pode ficar exposta no bundle do navegador.
// Isso é só o fallback pra quando `/api` não responde (npm run dev puro,
// sem vercel dev): mostra dado simulado (sem link, com aviso na tabela
// de Resultados) em vez de deixar a tela vazia. Rodando com `vercel dev`
// ou deployado, `priceApi.ts` prefere sempre o servidor — este registro
// nem chega a ser usado na prática. Shopee entra do mesmo jeito quando
// tiver provider: `registerProvider(createShopeeProvider())`.
registerProvider(createMockProvider("amazon", "Amazon"));
registerProvider(createMockProvider("mercadolivre", "Mercado Livre"));
