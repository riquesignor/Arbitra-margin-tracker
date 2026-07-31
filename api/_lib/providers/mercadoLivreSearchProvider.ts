import type { CatalogItemQuery, MarketplacePriceResult } from "../types";
import type { ServerPriceProvider } from "./types";
import { getMlAccessToken } from "../mlAuth";

const SEARCH_URL = "https://api.mercadolibre.com/sites/MLB/search";
const CONCURRENCY = 5;

interface MLSearchItem {
  id: string;
  title: string;
  price: number;
  permalink: string;
}

interface MLSearchResponse {
  results?: MLSearchItem[];
  paging?: { total?: number };
}

/** Roda no máximo `limit` chamadas em paralelo, pra não estourar rate limit da API. */
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
 * Busca real na API do Mercado Livre — AUTENTICADA via OAuth (ver
 * `api/_lib/mlAuth.ts`). Confirmado na documentação oficial
 * (developers.mercadolivre.com.br/en_us/items-and-searches) que
 * `/sites/$SITE_ID/search?q=...` exige `Authorization: Bearer
 * $ACCESS_TOKEN` — chamada sem esse header retorna 403 hoje em dia
 * (era pública antes; a Amazon nunca teve esse mock com token, ver
 * mockProvider). Setup do token: `scripts/ml-oauth-setup.mjs` (ver
 * README).
 *
 * Confiança fica em 0.55: é match por texto (nome do catálogo → título
 * do anúncio), não garantia de ser o mesmo produto — por isso o
 * `matchedTitle` sempre volta junto, pra conferência manual.
 */
export function createMercadoLivreSearchProvider(): ServerPriceProvider {
  return {
    id: "mercadolivre",
    async fetchPrices(items: CatalogItemQuery[]) {
      const accessToken = await getMlAccessToken();
      const results: Record<string, MarketplacePriceResult> = {};

      await mapWithConcurrency(items, CONCURRENCY, async ({ sku, name }) => {
        try {
          const url = `${SEARCH_URL}?q=${encodeURIComponent(name)}&limit=1`;
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });

          if (!response.ok) {
            console.warn(`Busca ML "${name}" (${sku}) retornou ${response.status}`);
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
          };
        } catch (err) {
          console.error(`Busca Mercado Livre falhou pra "${name}":`, err);
        }
      });

      return results;
    },
  };
}
