import type { CatalogItemQuery, MarketplacePriceResult } from "../../types";
import type { PriceProvider } from "./types";

const SEARCH_URL = "https://api.mercadolibre.com/sites/MLB/search";
const CONCURRENCY = 5;

interface MLSearchItem {
  id: string;
  title: string;
  price: number;
  permalink: string;
  thumbnail?: string;
}

interface MLSearchResponse {
  results?: MLSearchItem[];
  paging?: { total?: number };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Fallback client-side — só é usado quando `/api/fetch-prices` não
 * responde (`npm run dev` puro, sem `vercel dev`). Roda SEM autenticação
 * porque o client não pode guardar `ML_CLIENT_SECRET`/refresh_token com
 * segurança (ficaria exposto no bundle do navegador). A documentação
 * oficial do Mercado Livre confirma que `/sites/$SITE_ID/search` hoje
 * exige `Authorization: Bearer $ACCESS_TOKEN` — sem isso, a resposta é
 * 403 pra praticamente toda busca. Ou seja: **este fallback está
 * efetivamente inoperante hoje** (fica só documentando a tentativa e
 * logando o motivo do 403 no console). Pra busca real funcionando, use
 * `vercel dev` (que serve `/api`, autenticado — ver `api/_lib/mlAuth.ts`
 * e `scripts/ml-oauth-setup.mjs`).
 */
export function createMercadoLivreSearchProvider(): PriceProvider {
  return {
    id: "mercadolivre",
    label: "Mercado Livre",
    async fetchPrices(items: CatalogItemQuery[]) {
      const results: Record<string, MarketplacePriceResult> = {};

      await mapWithConcurrency(items, CONCURRENCY, async ({ sku, name }) => {
        try {
          const url = `${SEARCH_URL}?q=${encodeURIComponent(name)}&limit=1`;
          const response = await fetch(url);
          if (!response.ok) {
            console.warn(
              `Busca ML "${name}" retornou ${response.status} (esperado sem auth — use vercel dev pra busca real)`
            );
            return;
          }

          const data = (await response.json()) as MLSearchResponse;
          const match = data.results?.[0];
          if (!match) return;

          results[sku] = {
            marketplace: "mercadolivre",
            sku,
            price: match.price,
            competitorCount: Math.max(0, (data.paging?.total ?? 1) - 1),
            buyBoxEligible: true,
            confidence: 0.55,
            link: match.permalink,
            matchedTitle: match.title,
            imageUrl: match.thumbnail,
          };
        } catch (err) {
          console.error(`Busca Mercado Livre falhou pra "${name}":`, err);
        }
      });

      return results;
    },
  };
}
